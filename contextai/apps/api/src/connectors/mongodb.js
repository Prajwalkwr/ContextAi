// Read-only MongoDB connector. Only find / countDocuments / a $match-$group-$sort-$limit
// pipeline built here are ever sent; caller-supplied operators like $where cannot be expressed.
import { MongoClient } from 'mongodb';
import { inferType, metricKey } from './querySpec.js';

const clients = new Map();

async function database(integration) {
  const { connectionString, database: dbName } = integration.secrets;
  if (!connectionString) throw Object.assign(new Error('MongoDB connectionString missing'), { status: 400 });
  let client = clients.get(integration.id);
  if (!client) {
    client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 5000, maxPoolSize: 5 });
    await client.connect();
    clients.set(integration.id, client);
  }
  return client.db(dbName || undefined);
}

export function toMongoFilter(where) {
  const filter = {};
  for (const { field, op, value } of where) {
    const cond = op === 'eq' ? { $eq: value } : op === 'ne' ? { $ne: value } : op === 'in' ? { $in: value }
      : op === 'isnull' ? { $eq: null } : op === 'notnull' ? { $ne: null } : { [`$${op}`]: value };
    filter[field] = { ...(filter[field] || {}), ...cond };
  }
  return filter;
}

export function toMongoPipeline(spec) {
  const group = { _id: Object.fromEntries(spec.groupBy.map((g) => [g, `$${g}`])), count: { $sum: 1 } };
  for (const m of spec.metrics) if (m.op !== 'count') group[metricKey(m)] = { [`$${m.op}`]: `$${m.field}` };
  return [{ $match: toMongoFilter(spec.where) }, { $group: group }, { $sort: { count: -1 } }, { $limit: spec.limit }];
}

export const mongodbConnector = {
  label: 'MongoDB',
  async test(integration) {
    const start = Date.now();
    const d = await database(integration);
    await d.command({ ping: 1 });
    const names = (await d.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    return { ok: true, latencyMs: Date.now() - start, collections: names };
  },
  async discoverSchema(integration) {
    const d = await database(integration);
    const names = (await d.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
      .filter((n) => !integration.allowedCollections?.length || integration.allowedCollections.includes(n));
    const schema = {};
    for (const name of names) {
      const coll = d.collection(name);
      const sample = await coll.aggregate([{ $sample: { size: 50 } }]).toArray();
      const fields = [...new Set(sample.flatMap((r) => Object.keys(r)))].filter((f) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f));
      schema[name] = { count: await coll.estimatedDocumentCount(), fields: fields.map((f) => ({ name: f, type: inferType(sample.map((r) => r[f])) })) };
    }
    return schema;
  },
  async query(integration, spec) {
    const coll = (await database(integration)).collection(spec.collection);
    const filter = toMongoFilter(spec.where);
    const opts = { maxTimeMS: 5000 };
    if (spec.operation === 'count') return { count: await coll.countDocuments(filter, opts), rows: [] };
    if (spec.operation === 'aggregate') {
      const rows = await coll.aggregate(toMongoPipeline(spec), opts).toArray();
      return { count: rows.length, rows: rows.map(({ _id, ...rest }) => ({ key: _id, ...rest })) };
    }
    const cursor = coll.find(filter, { ...opts, projection: spec.fields ? Object.fromEntries(spec.fields.map((f) => [f, 1])) : undefined });
    if (spec.sort) cursor.sort({ [spec.sort.field]: spec.sort.dir });
    const rows = await cursor.limit(spec.limit).toArray();
    return { count: await coll.countDocuments(filter, opts), rows: rows.map((r) => JSON.parse(JSON.stringify(r))) };
  },
  async close(integrationId) {
    await clients.get(integrationId)?.close();
    clients.delete(integrationId);
  },
  async closeAll() {
    await Promise.all([...clients.keys()].map((k) => this.close(k)));
  },
};
