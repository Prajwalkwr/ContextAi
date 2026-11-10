import express from 'express';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { generateKeyPair, sha256 } from '../lib/crypto.js';
import { requireProject, requireUser, projectIdsForCaller } from '../middleware/auth.js';
import { WHERE_OPS } from '../connectors/querySpec.js';
import { parseFormula } from '../engine/formula.js';
import { parseRepoUrl } from '../understanding/github.js';
import { assertPublicUrl } from '../lib/netguard.js';
import { queueGithubIndex, queueWebsiteIndex } from '../knowledge/indexer.js';
import { checkProjectHealth } from '../assistant/health.js';

export const projectRouter = express.Router();

const publicIntegration = ({ encryptedConfig, ...rest }) => rest;
const publicProject = (p) => {
  if (!p?.assistant?.userTokenSecret) return p;
  const { userTokenSecret, ...assistant } = p.assistant;
  return { ...p, assistant: { ...assistant, userTokenSecretConfigured: true } };
};
const publicKeyView = ({ secretHash, ...rest }) => rest;

function createKeys(projectId, label) {
  const { publicKey, secretKey } = generateKeyPair();
  const key = db.createApiKey({ projectId, label, publicKey, secretHash: sha256(secretKey) });
  return { key: publicKeyView(key), publicKey, secretKey };
}

projectRouter.get('/overview', requireUser, (req, res) => {
  const ids = projectIdsForCaller(req.auth);
  const projects = db.listProjects(req.auth.userId);
  res.json({
    counts: db.countFor(ids),
    projects: projects.map((p) => ({ id: p.id, name: p.name, indexingStatus: p.indexingStatus, lastIndexedAt: p.lastIndexedAt, integrations: db.listIntegrations(p.id).length })),
    integrationHealth: ids.flatMap((id) => db.listIntegrations(id).map((i) => ({ projectId: id, name: i.name, type: i.type, status: i.status, error: i.health?.error }))),
    recentInvestigations: db.listInvestigations(ids, 8),
    jobs: db.listJobs(ids, 8),
    llm: process.env.OPENAI_API_KEY ? process.env.OPENAI_MODEL || 'gpt-4o-mini' : null,
  });
});

projectRouter.get('/logs', requireUser, (req, res) => {
  const ids = req.query.projectId ? projectIdsForCaller(req.auth).filter((id) => id === req.query.projectId) : projectIdsForCaller(req.auth);
  res.json({ audit: db.listAudit(ids, 200), investigations: db.listInvestigations(ids, 100), jobs: db.listJobs(ids, 50) });
});

projectRouter.get('/', requireUser, (req, res) => {
  res.json({ projects: db.listProjects(req.auth.userId).map(publicProject) });
});

const projectSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().max(1000).optional().default(''),
  websiteUrl: z.string().url().optional().or(z.literal('')),
  statusUrl: z.string().url().optional().or(z.literal('')),
  // Base URL of the backend when it is not served under the website's origin.
  apiUrl: z.string().url().optional().or(z.literal('')),
});

const assertPublicUrls = (body) => ['websiteUrl', 'statusUrl', 'apiUrl'].forEach((k) => body[k] && assertPublicUrl(body[k]));

const createSchema = projectSchema.extend({
  repositoryUrl: z.string().min(3).max(400).optional(),
  branch: z.string().max(200).optional(),
});

projectRouter.post('/', requireUser, (req, res, next) => {
  try {
    const { repositoryUrl, branch, ...body } = createSchema.parse(req.body);
    const repo = repositoryUrl ? parseRepoUrl(repositoryUrl) : null;
    assertPublicUrls(body);
    const ref = branch || repo?.branch || undefined;
    let project = db.createProject({ ...body, ownerId: req.auth.userId, indexingStatus: 'not_indexed' });
    const keys = createKeys(project.id, 'default');
    db.addAudit({ projectId: project.id, actor: req.auth.userId, action: 'project.create', target: project.name, status: 'success' });
    const jobs = [];
    if (repo) {
      db.updateProject(project.id, { repository: { fullName: repo.fullName, url: `https://github.com/${repo.fullName}`, branch: ref || null } });
      jobs.push(queueGithubIndex({ projectId: project.id, repositoryUrl, branch: ref, actor: req.auth.userId }));
    }
    if (body.websiteUrl) jobs.push(queueWebsiteIndex({ projectId: project.id, url: body.websiteUrl, actor: req.auth.userId }));
    if (jobs.length) project = db.getProject(project.id);
    res.status(201).json({ project, credentials: { publicKey: keys.publicKey, secretKey: keys.secretKey }, jobs });
  } catch (e) { next(e); }
});

projectRouter.get('/:id', requireProject('read'), (req, res) => {
  const id = req.project.id;
  res.json({
    project: publicProject(req.project),
    profile: db.getProfile(id),
    integrations: db.listIntegrations(id).map(publicIntegration),
    definitions: db.listDefinitions(id),
    tools: db.listTools(id).map(({ encryptedHeaders, ...t }) => t),
    apiKeys: db.listApiKeys(id).map(publicKeyView),
    jobs: db.listJobs([id], 10),
  });
});

projectRouter.patch('/:id', requireProject('manage'), (req, res, next) => {
  try {
    const body = projectSchema.partial().parse(req.body);
    assertPublicUrls(body);
    res.json({ project: publicProject(db.updateProject(req.project.id, body)) });
  } catch (e) { next(e); }
});

// Live health of the connected application (website, backend, database, integrations).
projectRouter.get('/:id/health', requireProject('read'), async (req, res, next) => {
  try {
    res.json({ health: await checkProjectHealth(req.project, { fresh: req.query.fresh === 'true' }) });
  } catch (e) { next(e); }
});

projectRouter.delete('/:id', requireUser, requireProject('manage'), (req, res) => {
  db.deleteProject(req.project.id);
  res.json({ deleted: true });
});

projectRouter.post('/:id/keys', requireUser, requireProject('manage'), (req, res) => {
  const keys = createKeys(req.project.id, String(req.body.label || 'key').slice(0, 40));
  db.addAudit({ projectId: req.project.id, actor: req.actor, action: 'key.create', target: keys.key.id, status: 'success' });
  res.status(201).json(keys);
});

projectRouter.delete('/:id/keys/:keyId', requireUser, requireProject('manage'), (req, res) => {
  const key = db.revokeApiKey(req.project.id, req.params.keyId);
  if (!key) return res.status(404).json({ error: 'Key not found' });
  db.addAudit({ projectId: req.project.id, actor: req.actor, action: 'key.revoke', target: key.id, status: 'success' });
  res.json({ revoked: true });
});

const primitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
const definitionSchema = z.object({
  term: z.string().trim().min(2).max(60),
  meaning: z.string().trim().min(3).max(500),
  collection: ident.optional(),
  field: ident.optional(),
  value: primitive.optional(),
  metricField: ident.optional(),
  formula: z.string().max(200).optional(),
  where: z.array(z.object({ field: ident, op: z.enum(WHERE_OPS), value: z.union([primitive, z.array(primitive)]).optional() })).max(5).optional(),
}).refine((d) => !d.formula || d.collection, { message: 'A formula needs a collection' });

projectRouter.post('/:id/definitions', requireProject('manage'), (req, res, next) => {
  try {
    const body = definitionSchema.parse(req.body);
    if (body.formula) parseFormula(body.formula);
    const def = db.createDefinition({ projectId: req.project.id, ...body, confirmedBy: req.actor });
    res.status(201).json({ definition: def });
  } catch (e) { next(e.status ? e : e.name === 'ZodError' ? e : Object.assign(e, { status: 400 })); }
});

projectRouter.delete('/:id/definitions/:defId', requireProject('manage'), (req, res) => {
  db.deleteDefinition(req.project.id, req.params.defId);
  res.json({ deleted: true });
});

projectRouter.get('/:id/jobs', requireProject('read'), (req, res) => {
  res.json({ jobs: db.listJobs([req.project.id], 20) });
});

projectRouter.get('/:id/investigations', requireProject('read'), (req, res) => {
  res.json({ investigations: db.listInvestigations([req.project.id]) });
});
