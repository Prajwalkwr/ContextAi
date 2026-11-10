// Per-project assistant configuration. The engine is identical for every deployment; everything
// that differs between an e-commerce site, a clinic or a SaaS dashboard is resolved here.
import { z } from 'zod';
import { db } from '../lib/db.js';
import { identityOf } from './identity.js';

const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
const domain = z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/);
const timeZone = z.string().trim().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}, 'Must be a valid IANA time zone');

export const assistantSettingsSchema = z.object({
  // Collection -> field holding the signed-in user's id. Only these collections can serve "my …" questions.
  userScopes: z.record(ident, ident).optional(),
  allowGeneralKnowledge: z.boolean().optional(),
  timeZone: timeZone.optional(),
  businessRules: z.array(z.string().trim().min(3).max(400)).max(30).optional(),
  searchConfiguration: z.object({
    webSearch: z.boolean().optional(),
    allowedDomains: z.array(domain).max(20).optional(),
  }).optional(),
  // What the project is and who uses it, verified by the owner; overrides what indexing derives.
  identity: z.object({
    summary: z.string().trim().min(10).max(800).optional(),
    audience: z.string().trim().max(400).optional(),
    roles: z.array(z.object({ name: z.string().trim().min(2).max(40), description: z.string().trim().max(300).optional() })).max(10).optional(),
    features: z.array(z.string().trim().min(3).max(200)).max(20).optional(),
  }).strict().optional(),
}).strict();

export const DEFAULT_SETTINGS = { userScopes: {}, allowGeneralKnowledge: true, timeZone: process.env.DEFAULT_TIME_ZONE || 'UTC', businessRules: [], searchConfiguration: { webSearch: true, allowedDomains: [] } };

export function settingsOf(project) {
  const s = project.assistant || {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    searchConfiguration: { ...DEFAULT_SETTINGS.searchConfiguration, ...(s.searchConfiguration || {}) },
    userScopes: s.userScopes || {},
    businessRules: s.businessRules || [],
  };
}

export function buildProjectConfig(project, userContext = null) {
  const settings = settingsOf(project);
  const profile = db.getProfile(project.id);
  const integrations = db.listIntegrations(project.id);
  const collections = [];
  for (const i of integrations) {
    for (const [name, info] of Object.entries(i.schema || {})) {
      if (i.allowedCollections?.length && !i.allowedCollections.includes(name)) continue;
      collections.push({ name, integration: i.name, kind: i.type, synthetic: !!i.synthetic, fields: (info.fields || []).map((f) => f.name) });
    }
  }
  const definitions = db.listDefinitions(project.id);
  const tools = db.listTools(project.id);
  const a = profile?.architecture;
  return {
    projectId: project.id,
    projectName: project.name,
    projectDescription: project.description || '',
    identity: identityOf(project, settings),
    websiteUrl: project.websiteUrl || profile?.website?.url || profile?.repository?.url || null,
    statusUrl: project.statusUrl || null,
    projectKnowledge: {
      indexed: !!profile,
      source: profile?.source || null,
      lastIndexedAt: project.lastIndexedAt || null,
      stack: a?.stack || null,
      modules: (a?.modules || []).slice(0, 10).map((m) => m.path),
      models: (a?.models || []).slice(0, 40).map((m) => ({ name: m.name, file: m.file, line: m.line })),
      routePaths: [...new Set((a?.routes || []).map((r) => r.path))].slice(0, 400),
    },
    availableTools: tools.map((t) => ({ id: t.id, name: t.name, method: t.method || 'GET', description: t.description })),
    apiIntegrations: integrations.map((i) => ({ name: i.name, type: i.type, status: i.status })),
    databasePermissions: { collections, userScopes: settings.userScopes },
    businessRules: [...settings.businessRules, ...definitions.map((d) => `${d.term}: ${d.meaning}`)],
    userContext,
    searchConfiguration: settings.searchConfiguration,
    timeZone: settings.timeZone,
    allowGeneralKnowledge: settings.allowGeneralKnowledge,
    knowledgeVersion: `${project.lastIndexedAt || ''}:${project.updatedAt || ''}`,
  };
}

// Compact, prompt-safe description of the project for routing and answering.
export function projectCard(config) {
  const s = config.projectKnowledge.stack;
  return [
    `Name: ${config.projectName}`,
    `Project time zone: ${config.timeZone}`,
    config.projectDescription && `Description (set by the project owner): ${config.projectDescription}`,
    config.identity?.summary && config.identity.summary !== config.projectDescription && `What it is: ${config.identity.summary}`,
    config.identity?.roles?.length && `Account types: ${config.identity.roles.map((r) => `${r.name}${r.description ? ` (${r.description})` : ''}`).join('; ')}`,
    config.identity?.features?.length && `Main features:\n- ${config.identity.features.join('\n- ')}`,
    config.websiteUrl && `Website/repository: ${config.websiteUrl}`,
    s && `Detected stack: frontend ${s.frontend.join(', ') || 'none'}; backend ${s.backend.join(', ') || 'none'}; data ${s.data.join(', ') || 'none'}; auth ${s.auth.join(', ') || 'none'}`,
    config.databasePermissions.collections.length && `Connected data collections: ${config.databasePermissions.collections.map((c) => `${c.name}${c.synthetic ? ' (synthetic sample)' : ''}`).join(', ')}`,
    config.availableTools.length && `Registered API tools: ${config.availableTools.map((t) => `${t.name} (${t.method})`).join(', ')}`,
    config.businessRules.length && `Business rules and definitions:\n- ${config.businessRules.slice(0, 20).join('\n- ')}`,
  ].filter(Boolean).join('\n');
}
