// Developer-uploaded JSON records (e.g. an export or a clearly labelled synthetic test set).
// Executes the same query spec in memory so the engine path is identical to live databases.
import { db } from '../lib/db.js';
import { inferType, metricKey } from './querySpec.js';

function collections(integration) {
  return db.getDataset(integration.projectId, integration.id)?.collections || {};
}

function matches(row, { field, op, value }) {
  const v = row[field];
  switch (op) {
    case 'eq': return v === value;
    case 'ne': return v !== value;
    case 'in': return value.includes(v);
    case 'gt': return v != null && v > value;
    case 'gte': return v != null && v >= value;
    case 'lt': return v != null && v < value;
    case 'lte': return v != null && v <= value;
    case 'isnull': return v === null || v === undefined;
    case 'notnull': return v !== null && v !== undefined;
    default: return false;
  }
}

export function runInMemory(rows, spec) {
  let result = rows.filter((r) => spec.where.every((c) => matches(r, c)));
  if (spec.operation === 'count') return { count: result.length, rows: [] };

  if (spec.operation === 'aggregate') {
    const groups = new Map();
    for (const r of result) {
      const key = spec.groupBy.map((g) => r[g] ?? null);
      const k = JSON.stringify(key);
      if (!groups.has(k)) groups.set(k, { key: Object.fromEntries(spec.groupBy.map((g, i) => [g, key[i]])), rows: [] });
      groups.get(k).rows.push(r);
    }
    const out = [...groups.values()].map(({ key, rows: groupRows }) => {
      const row = { key, count: groupRows.length };
      for (const m of spec.metrics) {
        if (m.op === 'count') continue;
        const nums = groupRows.map((r) => r[m.field]).filter((v) => typeof v === 'number');
        const sum = nums.reduce((a, b) => a + b, 0);
        row[metricKey(m)] = !nums.length ? null
          : m.op === 'sum' ? sum : m.op === 'avg' ? sum / nums.length : m.op === 'min' ? Math.min(...nums) : Math.max(...nums);
      }
      return row;
    });
    return { count: out.length, rows: out.slice(0, spec.limit) };
  }

  if (spec.sort) {
    const { field, dir } = spec.sort;
    result = [...result].sort((a, b) => ((a[field] ?? -Infinity) > (b[field] ?? -Infinity) ? dir : -dir));
  }
  const total = result.length;
  result = result.slice(0, spec.limit);
  if (spec.fields) result = result.map((r) => Object.fromEntries(spec.fields.map((f) => [f, r[f]])));
  return { count: total, rows: result };
}

export function schemaFromCollections(cols) {
  const schema = {};
  for (const [name, rows] of Object.entries(cols)) {
    const fieldNames = [...new Set(rows.slice(0, 200).flatMap((r) => Object.keys(r)))].filter((f) => /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(f));
    schema[name] = { count: rows.length, fields: fieldNames.map((f) => ({ name: f, type: inferType(rows.slice(0, 200).map((r) => r[f])) })) };
  }
  return schema;
}

export const datasetConnector = {
  label: 'Uploaded dataset',
  async test(integration) {
    const names = Object.keys(collections(integration));
    return names.length ? { ok: true, collections: names } : { ok: false, error: 'Dataset contains no collections' };
  },
  async discoverSchema(integration) {
    return schemaFromCollections(collections(integration));
  },
  async query(integration, spec) {
    return runInMemory(collections(integration)[spec.collection] || [], spec);
  },
};
