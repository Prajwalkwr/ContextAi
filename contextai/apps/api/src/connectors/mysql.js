// Read-only MySQL / MariaDB connector. Same guarantees as PostgreSQL: validated, backtick-quoted
// identifiers, bound values, and every query inside START TRANSACTION READ ONLY with a time limit.
import mysql from 'mysql2/promise';
import { metricKey } from './querySpec.js';

const pools = new Map();

function pool(integration) {
  let p = pools.get(integration.id);
  if (!p) {
    const { connectionString, ssl } = integration.secrets;
    if (!connectionString) throw Object.assign(new Error('MySQL connectionString missing'), { status: 400 });
    p = mysql.createPool({ uri: connectionString, connectionLimit: 5, connectTimeout: 5000, ssl: ssl ? { rejectUnauthorized: false } : undefined, dateStrings: true });
    pools.set(integration.id, p);
  }
  return p;
}

const q = (ident) => `\`${ident.replace(/`/g, '``')}\``;
const SQL_OPS = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const NUMERIC = /int|decimal|numeric|float|double|real|bit/;

export function buildMysql(spec) {
  const params = [];
  const clauses = spec.where.map(({ field, op, value }) => {
    if (op === 'isnull') return `${q(field)} IS NULL`;
    if (op === 'notnull') return `${q(field)} IS NOT NULL`;
    if (op === 'in') { params.push(...value); return value.length ? `${q(field)} IN (${value.map(() => '?').join(', ')})` : 'FALSE'; }
    params.push(value);
    return `${q(field)} ${SQL_OPS[op]} ?`;
  });
  const whereSql = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const from = q(spec.collection);
  if (spec.operation === 'count') return { text: `SELECT COUNT(*) AS count FROM ${from}${whereSql}`, params };
  if (spec.operation === 'aggregate') {
    const groups = spec.groupBy.map(q);
    const metrics = spec.metrics.filter((m) => m.op !== 'count').map((m) => `${m.op.toUpperCase()}(${q(m.field)}) AS ${q(metricKey(m))}`);
    const groupSql = groups.length ? ` GROUP BY ${groups.join(', ')}` : '';
    return { text: `SELECT ${[...groups, 'COUNT(*) AS count', ...metrics].join(', ')} FROM ${from}${whereSql}${groupSql} ORDER BY count DESC LIMIT ${Number(spec.limit)}`, params };
  }
  const cols = spec.fields ? spec.fields.map(q).join(', ') : '*';
  const order = spec.sort ? ` ORDER BY ${q(spec.sort.field)} ${spec.sort.dir === -1 ? 'DESC' : 'ASC'}` : '';
  return { text: `SELECT ${cols} FROM ${from}${whereSql}${order} LIMIT ${Number(spec.limit)}`, params };
}

const num = (v) => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);

async function readOnly(integration, fn) {
  const conn = await pool(integration).getConnection();
  try {
    await conn.query('SET SESSION MAX_EXECUTION_TIME = 5000').catch(() => {});
    await conn.query('START TRANSACTION READ ONLY');
    const result = await fn(conn);
    await conn.query('COMMIT');
    return result;
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

export const mysqlConnector = {
  label: 'MySQL / MariaDB',
  async test(integration) {
    const start = Date.now();
    await readOnly(integration, (c) => c.query('SELECT 1'));
    return { ok: true, latencyMs: Date.now() - start };
  },
  async discoverSchema(integration) {
    const [rows] = await readOnly(integration, (c) => c.query(
      'SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION'));
    const schema = {};
    for (const r of rows) {
      if (integration.allowedCollections?.length && !integration.allowedCollections.includes(r.t)) continue;
      schema[r.t] ||= { count: null, fields: [] };
      const type = NUMERIC.test(r.d) ? 'number' : /date|time/.test(r.d) ? 'date' : 'string';
      schema[r.t].fields.push({ name: r.c, type });
    }
    return schema;
  },
  async query(integration, spec) {
    return readOnly(integration, async (c) => {
      const { text, params } = buildMysql(spec);
      const [rows] = await c.query(text, params);
      const clean = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, num(v)])));
      if (spec.operation === 'count') return { count: Number(clean[0].count), rows: [] };
      if (spec.operation === 'aggregate') {
        return { count: clean.length, rows: clean.map((r) => ({ key: Object.fromEntries(spec.groupBy.map((g) => [g, r[g]])), ...Object.fromEntries(Object.entries(r).filter(([k]) => !spec.groupBy.includes(k))) })) };
      }
      const countSql = buildMysql({ ...spec, operation: 'count' });
      const [[total]] = await c.query(countSql.text, countSql.params);
      return { count: Number(total.count), rows: clean };
    });
  },
  async closeAll() {
    await Promise.all([...pools.values()].map((p) => p.end()));
    pools.clear();
  },
};
