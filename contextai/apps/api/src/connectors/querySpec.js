// Every connector receives the same validated, declarative query spec.
// The engine (and any LLM behind it) can only express what this spec allows:
// read operations, allowlisted collections, known fields, primitive values.

export const OPERATIONS = ['find', 'count', 'aggregate'];
export const WHERE_OPS = ['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'isnull', 'notnull'];
export const METRIC_OPS = ['count', 'sum', 'avg', 'min', 'max'];
export const MAX_LIMIT = 1000;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function fail(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

const isPrimitive = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

export function isAllowed(integration, collection) {
  const list = integration.allowedCollections;
  return !list?.length || list.includes(collection);
}

export function validateSpec(spec, integration, schema) {
  const { operation, collection, where = [], groupBy = [], metrics = [], fields, sort, limit } = spec;
  if (!OPERATIONS.includes(operation)) fail(`Unsupported operation: ${operation}`);
  if (!IDENT.test(collection || '')) fail('Invalid collection name');
  if (!isAllowed(integration, collection)) throw Object.assign(new Error(`Collection "${collection}" is not allowlisted for this integration`), { status: 403 });

  const known = schema?.[collection]?.fields?.map((f) => f.name);
  if (schema && !known) fail(`Unknown collection: ${collection}`);
  const checkField = (f) => {
    if (!IDENT.test(f || '')) fail(`Invalid field name: ${f}`);
    if (known && !known.includes(f)) fail(`Unknown field "${f}" on ${collection}`);
  };

  if (!Array.isArray(where) || where.length > 10) fail('where must be an array of at most 10 conditions');
  for (const c of where) {
    checkField(c.field);
    if (!WHERE_OPS.includes(c.op)) fail(`Unsupported operator: ${c.op}`);
    if (c.op === 'in') {
      if (!Array.isArray(c.value) || c.value.length > 100 || !c.value.every(isPrimitive)) fail('in requires an array of primitives');
    } else if (!['isnull', 'notnull'].includes(c.op) && !isPrimitive(c.value)) fail('Condition values must be primitives');
  }
  if (!Array.isArray(groupBy) || groupBy.length > 3) fail('groupBy supports at most 3 fields');
  groupBy.forEach(checkField);
  if (!Array.isArray(metrics) || metrics.length > 10) fail('At most 10 metrics');
  for (const m of metrics) {
    if (!METRIC_OPS.includes(m.op)) fail(`Unsupported metric: ${m.op}`);
    if (m.op !== 'count') checkField(m.field);
  }
  if (fields) (Array.isArray(fields) ? fields : fail('fields must be an array')).forEach(checkField);
  if (sort) {
    checkField(sort.field);
    if (![1, -1].includes(sort.dir)) fail('sort.dir must be 1 or -1');
  }
  return { operation, collection, where, groupBy, metrics, fields, sort, limit: Math.min(Math.max(Number(limit) || 100, 1), MAX_LIMIT) };
}

export const metricKey = (m) => (m.op === 'count' ? 'count' : `${m.op}_${m.field}`);

export function inferType(values) {
  const sample = values.filter((v) => v !== null && v !== undefined);
  if (!sample.length) return 'unknown';
  if (sample.every((v) => typeof v === 'number')) return 'number';
  if (sample.every((v) => typeof v === 'boolean')) return 'boolean';
  if (sample.every((v) => v instanceof Date || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)))) return 'date';
  if (sample.every((v) => typeof v === 'string' || (v && typeof v.toHexString === 'function'))) return 'string';
  return 'object';
}
