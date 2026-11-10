// Read-only PostgreSQL connector. Identifiers are validated against the discovered schema and
// quoted; every value is a bind parameter; each query runs in a READ ONLY transaction with a timeout.
import pg from 'pg';
import { metricKey } from './querySpec.js';

const pools = new Map();

function pool(integration) {
  let p = pools.get(integration.id);
  if (!p) {
    const { connectionString, ssl } = integration.secrets;
    if (!connectionString) throw Object.assign(new Error('PostgreSQL connectionString missing'), { status: 400 });
    p = new pg.Pool({ connectionString, ssl: ssl ? { rejectUnauthorized: false } : undefined, max: 5, connectionTimeoutMillis: 5000 });
    pools.set(integration.id, p);
  }
  return p;
}

const q = (ident) => `"${ident.replace(/"/g, '""')}"`;
const SQL_OPS = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const TYPE_MAP = { integer: 'number', bigint: 'number', numeric: 'number', 'double precision': 'number', real: 'number', smallint: 'number', boolean: 'boolean', date: 'date' };

export function buildSql(spec, schemaName = 'public') {
  const params = [];
  const bind = (v) => { params.push(v); return `$${params.length}`; };
  const clauses = spec.where.map(({ field, op, value }) => {
    if (op === 'isnull') return `${q(field)} IS NULL`;
    if (op === 'notnull') return `${q(field)} IS NOT NULL`;
    if (op === 'in') return `${q(field)} = ANY(${bind(value)})`;
    return `${q(field)} ${SQL_OPS[op]} ${bind(value)}`;
  });
  const from = `${q(schemaName)}.${q(spec.collection)}`;
  const whereSql = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';

  if (spec.operation === 'count') return { text: `SELECT COUNT(*)::int AS count FROM ${from}${whereSql}`, params };
  if (spec.operation === 'aggregate') {
    const groups = spec.groupBy.map(q);
    const metrics = spec.metrics.filter((m) => m.op !== 'count').map((m) => `${m.op.toUpperCase()}(${q(m.field)})::float AS ${q(metricKey(m))}`);
    const select = [...groups, 'COUNT(*)::int AS count', ...metrics].join(', ');
    const groupSql = groups.length ? ` GROUP BY ${groups.join(', ')}` : '';
    return { text: `SELECT ${select} FROM ${from}${whereSql}${groupSql} ORDER BY count DESC LIMIT ${bind(spec.limit)}`, params };
  }
  const cols = spec.fields ? spec.fields.map(q).join(', ') : '*';
  const order = spec.sort ? ` ORDER BY ${q(spec.sort.field)} ${spec.sort.dir === -1 ? 'DESC' : 'ASC'}` : '';
  return { text: `SELECT ${cols} FROM ${from}${whereSql}${order} LIMIT ${bind(spec.limit)}`, params };
}

async function readOnly(integration, fn) {
  const client = await pool(integration).connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export const postgresqlConnector = {
  label: 'PostgreSQL',
  async test(integration) {
    const start = Date.now();
    await readOnly(integration, (c) => c.query('SELECT 1'));
    return { ok: true, latencyMs: Date.now() - start };
  },
  async discoverSchema(integration) {
    const schemaName = integration.secrets.schema || 'public';
    const { rows } = await readOnly(integration, (c) => c.query(
      'SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position', [schemaName]));
    const schema = {};
    for (const r of rows) {
      if (integration.allowedCollections?.length && !integration.allowedCollections.includes(r.table_name)) continue;
      schema[r.table_name] ||= { count: null, fields: [] };
      const type = TYPE_MAP[r.data_type] || (r.data_type.startsWith('timestamp') ? 'date' : 'string');
      schema[r.table_name].fields.push({ name: r.column_name, type });
    }
    return schema;
  },
  async query(integration, spec) {
    const schemaName = integration.secrets.schema || 'public';
    return readOnly(integration, async (c) => {
      const { text, params } = buildSql(spec, schemaName);
      const { rows } = await c.query(text, params);
      if (spec.operation === 'count') return { count: rows[0].count, rows: [] };
      if (spec.operation === 'aggregate') {
        return { count: rows.length, rows: rows.map((r) => ({ key: Object.fromEntries(spec.groupBy.map((g) => [g, r[g]])), ...Object.fromEntries(Object.entries(r).filter(([k]) => !spec.groupBy.includes(k))) })) };
      }
      const total = await c.query(buildSql({ ...spec, operation: 'count' }, schemaName).text, buildSql({ ...spec, operation: 'count' }, schemaName).params);
      return { count: total.rows[0].count, rows };
    });
  },
  async close(integrationId) {
    await pools.get(integrationId)?.end();
    pools.delete(integrationId);
  },
  async closeAll() {
    await Promise.all([...pools.keys()].map((k) => this.close(k)));
  },
};
