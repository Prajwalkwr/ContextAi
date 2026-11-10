import express from 'express';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { encrypt } from '../lib/crypto.js';
import { requireProject, requireUser } from '../middleware/auth.js';
import { SUPPORTED_TYPES, connectors, refreshSchema, testIntegration, executeQuery } from '../connectors/index.js';
import { executeTool, isWrite, validateParams } from '../connectors/restTools.js';

export const integrationRouter = express.Router();

const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
const publicView = ({ encryptedConfig, ...rest }) => rest;

const dbConfig = z.object({ connectionString: z.string().min(5).max(1000), database: z.string().max(100).optional(), schema: z.string().max(100).optional(), ssl: z.boolean().optional() });
const httpConfig = z.object({
  mode: z.enum(['rest', 'graphql', 'csv', 'firestore']),
  sources: z.array(z.object({ name: ident, url: z.string().url(), path: z.string().max(200).optional(), query: z.string().max(5000).optional(), variables: z.record(z.string(), z.any()).optional() })).min(1).max(50),
  headers: z.record(z.string(), z.string().max(2000)).optional(),
}).refine((c) => c.mode !== 'graphql' || c.sources.every((s) => s.query && /^\s*(query\b|\{)/.test(s.query)), { message: 'GraphQL sources need a read-only query (mutations are not allowed)' });

const integrationSchema = z.object({
  type: z.enum(SUPPORTED_TYPES),
  name: z.string().trim().min(2).max(60),
  allowedCollections: z.array(ident).max(200).optional(),
  config: z.any().optional(),
  collections: z.record(ident, z.array(z.record(z.string(), z.any())).max(50_000)).optional(),
  synthetic: z.boolean().optional(),
});

integrationRouter.post('/:id/integrations', requireProject('manage'), async (req, res, next) => {
  try {
    const body = integrationSchema.parse(req.body);
    if (body.type === 'dataset' && !body.collections) return res.status(400).json({ error: 'Dataset integrations need "collections": { name: [records] }' });
    if (body.type === 'http') body.config = httpConfig.parse(body.config);
    else if (body.type !== 'dataset') body.config = dbConfig.parse(body.config || {});
    const integration = db.createIntegration({
      projectId: req.project.id,
      type: body.type,
      name: body.name,
      allowedCollections: body.allowedCollections?.length ? body.allowedCollections : null,
      synthetic: body.type === 'dataset' ? !!body.synthetic : false,
      encryptedConfig: body.type === 'dataset' ? null : encrypt(body.config),
      status: 'pending',
    });
    if (body.type === 'dataset') db.saveDataset(req.project.id, integration.id, body.collections);
    const health = await testIntegration(integration);
    if (health.ok) await refreshSchema(db.getIntegration(req.project.id, integration.id)).catch(() => {});
    db.addAudit({ projectId: req.project.id, actor: req.actor, action: 'integration.create', target: `${body.type}:${body.name}`, status: health.ok ? 'success' : 'error', error: health.error });
    res.status(201).json({ integration: publicView(db.getIntegration(req.project.id, integration.id)), health });
  } catch (e) { next(e); }
});

integrationRouter.get('/:id/integrations', requireProject('read'), (req, res) => {
  res.json({ integrations: db.listIntegrations(req.project.id).map(publicView), supported: SUPPORTED_TYPES.map((t) => ({ type: t, label: connectors[t].label })) });
});

function findIntegration(req, res) {
  const integration = db.getIntegration(req.project.id, req.params.intId);
  if (!integration) res.status(404).json({ error: 'Integration not found' });
  return integration;
}

integrationRouter.post('/:id/integrations/:intId/test', requireProject('manage'), async (req, res) => {
  const integration = findIntegration(req, res);
  if (!integration) return;
  const health = await testIntegration(integration);
  res.json({ health });
});

integrationRouter.post('/:id/integrations/:intId/schema', requireProject('manage'), async (req, res, next) => {
  const integration = findIntegration(req, res);
  if (!integration) return;
  try { res.json({ schema: await refreshSchema(integration) }); } catch (e) { next(Object.assign(e, { status: e.status || 502 })); }
});

integrationRouter.patch('/:id/integrations/:intId', requireProject('manage'), (req, res, next) => {
  const integration = findIntegration(req, res);
  if (!integration) return;
  try {
    const { allowedCollections } = z.object({ allowedCollections: z.array(ident).max(200) }).parse(req.body);
    res.json({ integration: publicView(db.updateIntegration(integration.id, { allowedCollections: allowedCollections.length ? allowedCollections : null })) });
  } catch (e) { next(e); }
});

integrationRouter.delete('/:id/integrations/:intId', requireProject('manage'), async (req, res) => {
  const integration = findIntegration(req, res);
  if (!integration) return;
  await connectors[integration.type]?.close?.(integration.id);
  db.deleteIntegration(req.project.id, integration.id);
  db.addAudit({ projectId: req.project.id, actor: req.actor, action: 'integration.delete', target: integration.name, status: 'success' });
  res.json({ deleted: true });
});

// Direct structured query: the same validated spec the engine uses (useful for dashboards).
integrationRouter.post('/:id/integrations/:intId/query', requireProject('read'), async (req, res, next) => {
  const integration = findIntegration(req, res);
  if (!integration) return;
  try {
    res.json(await executeQuery({ projectId: req.project.id, integration, spec: req.body, actor: req.actor }));
  } catch (e) { next(e); }
});

const paramName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/);
const toolSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'lowercase snake_case name'),
  description: z.string().min(5).max(300),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().default('GET'),
  url: z.string().url().refine((u) => /^https?:/.test(u), 'http(s) only'),
  parameters: z.array(paramName).max(10).optional().default([]),
  requiredParameters: z.array(paramName).max(10).optional().default([]),
  headers: z.record(z.string(), z.string().max(500)).optional(),
});
const toolView = ({ encryptedHeaders, ...t }) => t;

integrationRouter.post('/:id/tools', requireProject('manage'), (req, res, next) => {
  try {
    const { headers, ...body } = toolSchema.parse(req.body);
    const placeholders = [...body.url.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    body.parameters = [...new Set([...body.parameters, ...placeholders])];
    body.requiredParameters = [...new Set([...body.requiredParameters, ...placeholders])];
    const tool = db.createTool({ projectId: req.project.id, ...body, requiresApproval: body.method !== 'GET', encryptedHeaders: headers ? encrypt(headers) : null });
    res.status(201).json({ tool: toolView(tool) });
  } catch (e) { next(e); }
});

integrationRouter.post('/:id/tools/:toolId/execute', requireProject('read'), async (req, res, next) => {
  const tool = db.getTool(req.project.id, req.params.toolId);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  try { res.json(await executeTool({ projectId: req.project.id, tool, params: req.body?.params || {}, actor: req.actor })); } catch (e) { next(e); }
});

integrationRouter.delete('/:id/tools/:toolId', requireProject('manage'), (req, res) => {
  db.deleteTool(req.project.id, req.params.toolId);
  res.json({ deleted: true });
});

// Approval workflow for data-changing tools: request → human approval → single execution.
integrationRouter.post('/:id/actions', requireProject('read'), (req, res, next) => {
  try {
    const { toolId, params, reason } = z.object({ toolId: z.string(), params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().default({}), reason: z.string().max(500).optional() }).parse(req.body);
    const tool = db.getTool(req.project.id, toolId);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    if (!isWrite(tool)) return res.status(400).json({ error: 'Read-only tools do not need approval; execute them directly' });
    validateParams(tool, params);
    const action = db.createAction({ projectId: req.project.id, toolId, toolName: tool.name, method: tool.method, params, reason: reason || null, requestedBy: req.actor, status: 'pending' });
    db.addAudit({ projectId: req.project.id, actor: req.actor, action: 'action.request', target: tool.name, status: 'success', actionId: action.id });
    res.status(201).json({ action });
  } catch (e) { next(e); }
});

integrationRouter.get('/:id/actions', requireProject('read'), (req, res) => {
  res.json({ actions: db.listActions(req.project.id) });
});

integrationRouter.post('/:id/actions/:actionId/:decision', requireUser, requireProject('manage'), async (req, res, next) => {
  const { decision } = req.params;
  if (!['approve', 'reject'].includes(decision)) return res.status(404).json({ error: 'Not found' });
  const action = db.getAction(req.project.id, req.params.actionId);
  if (!action) return res.status(404).json({ error: 'Action not found' });
  if (action.status !== 'pending') return res.status(409).json({ error: `Action is already ${action.status}` });
  if (decision === 'reject') {
    db.addAudit({ projectId: req.project.id, actor: req.actor, action: 'action.reject', target: action.toolName, status: 'success', actionId: action.id });
    return res.json({ action: db.updateAction(action.id, { status: 'rejected', decidedBy: req.actor, decidedAt: new Date().toISOString() }) });
  }
  const tool = db.getTool(req.project.id, action.toolId);
  if (!tool) return res.status(410).json({ error: 'The tool for this action no longer exists' });
  db.updateAction(action.id, { status: 'executing', decidedBy: req.actor, decidedAt: new Date().toISOString() });
  try {
    const result = await executeTool({ projectId: req.project.id, tool, params: action.params, actor: req.actor, approvedActionId: action.id });
    res.json({ action: db.updateAction(action.id, { status: result.ok ? 'executed' : 'failed', result }) });
  } catch (e) {
    db.updateAction(action.id, { status: 'failed', result: { error: e.message } });
    next(e);
  }
});
