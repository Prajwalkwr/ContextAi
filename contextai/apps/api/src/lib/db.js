// Platform metadata store. A single JSON file keeps the MVP dependency-free;
// every accessor is project-scoped so it can be swapped for PostgreSQL without touching callers.
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const COLLECTIONS = ['users', 'projects', 'profiles', 'chunks', 'integrations', 'datasets', 'tools', 'actions', 'definitions', 'apiKeys', 'audit', 'investigations', 'jobs'];

function dataFile() {
  const dir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'platform.json');
}

let cache = null;
let cacheFile = null;

function load() {
  const file = dataFile();
  if (cache && cacheFile === file) return cache;
  let data = {};
  if (fs.existsSync(file)) {
    try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { data = {}; }
  }
  for (const c of COLLECTIONS) data[c] ||= [];
  cache = data;
  cacheFile = file;
  return data;
}

function save() {
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
}

const id = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const now = () => new Date().toISOString();

function insert(collection, prefix, doc) {
  const record = { id: id(prefix), createdAt: now(), ...doc };
  load()[collection].push(record);
  save();
  return record;
}

function update(collection, recordId, patch) {
  const rows = load()[collection];
  const idx = rows.findIndex((r) => r.id === recordId);
  if (idx === -1) return null;
  rows[idx] = { ...rows[idx], ...patch, updatedAt: now() };
  save();
  return rows[idx];
}

function remove(collection, predicate) {
  const data = load();
  data[collection] = data[collection].filter((r) => !predicate(r));
  save();
}

export const db = {
  reset() { cache = null; cacheFile = null; },

  createUser: (u) => insert('users', 'user', u),
  findUserByEmail: (email) => load().users.find((u) => u.email === email.toLowerCase()),
  findUserById: (userId) => load().users.find((u) => u.id === userId),

  createProject: (p) => insert('projects', 'proj', p),
  getProject: (projectId) => load().projects.find((p) => p.id === projectId),
  listProjects: (ownerId) => load().projects.filter((p) => p.ownerId === ownerId),
  listAllProjects: () => load().projects,
  updateProject: (projectId, patch) => update('projects', projectId, patch),
  findProjectsByRepo: (repoFullName) => load().projects.filter((p) => p.repository?.fullName?.toLowerCase() === repoFullName.toLowerCase()),
  deleteProject(projectId) {
    remove('projects', (p) => p.id === projectId);
    for (const c of COLLECTIONS.filter((c) => !['users', 'projects'].includes(c))) remove(c, (r) => r.projectId === projectId);
  },

  upsertProfile(projectId, profile) {
    const data = load();
    const existing = data.profiles.find((p) => p.projectId === projectId);
    if (existing) Object.assign(existing, profile, { updatedAt: now() });
    else data.profiles.push({ projectId, ...profile, updatedAt: now() });
    save();
  },
  getProfile: (projectId) => load().profiles.find((p) => p.projectId === projectId) || null,

  // With an origin ('code' | 'website') only that source's chunks are replaced.
  replaceChunks(projectId, chunks, origin = null) {
    const data = load();
    const originOf = (c) => c.origin || (/^(site\/|website-summary)/.test(c.source) ? 'website' : 'code');
    data.chunks = data.chunks.filter((c) => c.projectId !== projectId || (origin && originOf(c) !== origin));
    for (const c of chunks) data.chunks.push({ id: id('chunk'), projectId, ...c });
    save();
  },
  getChunks: (projectId) => load().chunks.filter((c) => c.projectId === projectId),

  createIntegration: (i) => insert('integrations', 'int', i),
  listIntegrations: (projectId) => load().integrations.filter((i) => i.projectId === projectId),
  getIntegration: (projectId, intId) => load().integrations.find((i) => i.id === intId && i.projectId === projectId),
  updateIntegration: (intId, patch) => update('integrations', intId, patch),
  deleteIntegration(projectId, intId) {
    remove('integrations', (i) => i.id === intId && i.projectId === projectId);
    remove('datasets', (d) => d.integrationId === intId && d.projectId === projectId);
  },

  saveDataset(projectId, integrationId, collections) {
    remove('datasets', (d) => d.integrationId === integrationId);
    return insert('datasets', 'ds', { projectId, integrationId, collections });
  },
  getDataset: (projectId, integrationId) => load().datasets.find((d) => d.projectId === projectId && d.integrationId === integrationId),

  createTool: (t) => insert('tools', 'tool', t),
  listTools: (projectId) => load().tools.filter((t) => t.projectId === projectId),
  getTool: (projectId, toolId) => load().tools.find((t) => t.projectId === projectId && t.id === toolId),
  deleteTool: (projectId, toolId) => remove('tools', (t) => t.projectId === projectId && t.id === toolId),

  createAction: (a) => insert('actions', 'act', a),
  listActions: (projectId) => load().actions.filter((a) => a.projectId === projectId).slice(-100).reverse(),
  getAction: (projectId, actionId) => load().actions.find((a) => a.projectId === projectId && a.id === actionId),
  updateAction: (actionId, patch) => update('actions', actionId, patch),

  createDefinition: (d) => insert('definitions', 'def', d),
  listDefinitions: (projectId) => load().definitions.filter((d) => d.projectId === projectId),
  deleteDefinition: (projectId, defId) => remove('definitions', (d) => d.projectId === projectId && d.id === defId),

  createApiKey: (k) => insert('apiKeys', 'key', k),
  findApiKeyByPublic: (publicKey) => load().apiKeys.find((k) => k.publicKey === publicKey && !k.revokedAt),
  findApiKeyBySecretHash: (hash) => load().apiKeys.find((k) => k.secretHash === hash && !k.revokedAt),
  listApiKeys: (projectId) => load().apiKeys.filter((k) => k.projectId === projectId),
  revokeApiKey: (projectId, keyId) => {
    const key = load().apiKeys.find((k) => k.projectId === projectId && k.id === keyId);
    return key ? update('apiKeys', keyId, { revokedAt: now() }) : null;
  },

  addAudit(entry) {
    const data = load();
    data.audit.push({ id: id('audit'), timestamp: now(), ...entry });
    if (data.audit.length > 5000) data.audit = data.audit.slice(-5000);
    save();
  },
  listAudit: (projectIds, limit = 100) => load().audit.filter((a) => projectIds.includes(a.projectId)).slice(-limit).reverse(),

  saveInvestigation: (inv) => insert('investigations', 'inv', inv),
  listInvestigations: (projectIds, limit = 50) => load().investigations.filter((i) => projectIds.includes(i.projectId)).slice(-limit).reverse(),

  createJob: (j) => insert('jobs', 'job', { status: 'queued', ...j }),
  updateJob: (jobId, patch) => update('jobs', jobId, patch),
  listJobs: (projectIds, limit = 50) => load().jobs.filter((j) => projectIds.includes(j.projectId)).slice(-limit).reverse(),

  countFor(projectIds) {
    const d = load();
    const inScope = (r) => projectIds.includes(r.projectId);
    return {
      projects: projectIds.length,
      chunks: d.chunks.filter(inScope).length,
      integrations: d.integrations.filter(inScope).length,
      investigations: d.investigations.filter(inScope).length,
      toolExecutions: d.audit.filter((a) => inScope(a) && a.action?.startsWith('query.')).length,
      errors: d.audit.filter((a) => inScope(a) && a.status === 'error').length,
    };
  },
};
