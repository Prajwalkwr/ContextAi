import { db } from '../lib/db.js';
import { decrypt } from '../lib/crypto.js';
import { validateSpec } from './querySpec.js';
import { datasetConnector } from './dataset.js';
import { mongodbConnector } from './mongodb.js';
import { postgresqlConnector } from './postgresql.js';
import { mysqlConnector } from './mysql.js';
import { httpConnector } from './http.js';

// New data sources plug in here; the engine only ever talks to this interface.
export const connectors = {
  dataset: datasetConnector,
  mongodb: mongodbConnector,
  postgresql: postgresqlConnector,
  mysql: mysqlConnector,
  http: httpConnector,
};

export const SUPPORTED_TYPES = Object.keys(connectors);

export const closeAllConnections = () => Promise.all(Object.values(connectors).map((c) => c.closeAll?.()));

function withSecrets(integration) {
  return { ...integration, secrets: integration.type === 'dataset' ? {} : decrypt(integration.encryptedConfig) };
}

function connectorFor(integration) {
  const c = connectors[integration.type];
  if (!c) throw Object.assign(new Error(`Connector "${integration.type}" is not implemented`), { status: 501 });
  return c;
}

export async function testIntegration(integration) {
  try {
    const health = await connectorFor(integration).test(withSecrets(integration));
    db.updateIntegration(integration.id, { status: health.ok ? 'connected' : 'error', health, lastCheckedAt: new Date().toISOString() });
    return health;
  } catch (e) {
    const health = { ok: false, error: e.message };
    db.updateIntegration(integration.id, { status: 'error', health, lastCheckedAt: new Date().toISOString() });
    return health;
  }
}

export async function refreshSchema(integration) {
  const schema = await connectorFor(integration).discoverSchema(withSecrets(integration));
  db.updateIntegration(integration.id, { schema, schemaRefreshedAt: new Date().toISOString() });
  return schema;
}

// Single choke point for live data access: allowlist + schema validation + audit.
export async function executeQuery({ projectId, integration, spec, actor }) {
  if (integration.projectId !== projectId) throw Object.assign(new Error('Integration does not belong to project'), { status: 403 });
  const schema = integration.schema || await refreshSchema(integration);
  const safe = validateSpec(spec, integration, schema);
  try {
    const result = await connectorFor(integration).query(withSecrets(integration), safe);
    db.addAudit({ projectId, actor, action: `query.${safe.operation}`, target: `${integration.name}/${safe.collection}`, status: 'success' });
    return { ...result, spec: safe };
  } catch (e) {
    db.addAudit({ projectId, actor, action: `query.${safe.operation}`, target: `${integration.name}/${safe.collection}`, status: 'error', error: e.message });
    throw e;
  }
}
