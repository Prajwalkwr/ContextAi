import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSpec } from '../apps/api/src/connectors/querySpec.js';
import { buildSql } from '../apps/api/src/connectors/postgresql.js';
import { toMongoFilter, toMongoPipeline } from '../apps/api/src/connectors/mongodb.js';
import { runInMemory } from '../apps/api/src/connectors/dataset.js';
import { parseFormula } from '../apps/api/src/engine/formula.js';
import { classifyIntent, extractTimeRange } from '../apps/api/src/engine/intent.js';
import { stem, tokenize } from '../apps/api/src/knowledge/search.js';
import { analyzeProject, isIndexable } from '../apps/api/src/understanding/analyzer.js';
import { parseRepoUrl } from '../apps/api/src/understanding/github.js';

const schema = { orders: { fields: [{ name: 'status', type: 'string' }, { name: 'amount', type: 'number' }] } };
const integration = { allowedCollections: ['orders'] };

test('query spec rejects anything outside the allowlist and schema', () => {
  assert.throws(() => validateSpec({ operation: 'find', collection: 'users' }, integration, schema), /not allowlisted/);
  assert.throws(() => validateSpec({ operation: 'delete', collection: 'orders' }, integration, schema), /Unsupported operation/);
  assert.throws(() => validateSpec({ operation: 'find', collection: 'orders', where: [{ field: '$where', op: 'eq', value: 1 }] }, integration, schema), /Invalid field/);
  assert.throws(() => validateSpec({ operation: 'find', collection: 'orders', where: [{ field: 'status', op: 'eq', value: { $gt: '' } }] }, integration, schema), /primitives/);
  assert.throws(() => validateSpec({ operation: 'find', collection: 'orders', where: [{ field: 'secret', op: 'eq', value: 1 }] }, integration, schema), /Unknown field/);
  assert.throws(() => validateSpec({ operation: 'find', collection: 'orders; DROP TABLE x' }, integration, schema), /Invalid collection/);
  assert.equal(validateSpec({ operation: 'find', collection: 'orders', limit: 999999 }, integration, schema).limit, 1000);
});

test('postgres SQL is parameterised and identifiers are quoted', () => {
  const spec = validateSpec({ operation: 'aggregate', collection: 'orders', where: [{ field: 'status', op: 'in', value: ["x'); DROP TABLE orders;--"] }], groupBy: ['status'], metrics: [{ op: 'sum', field: 'amount' }] }, integration, schema);
  const { text, params } = buildSql(spec);
  assert.equal(text, 'SELECT "status", COUNT(*)::int AS count, SUM("amount")::float AS "sum_amount" FROM "public"."orders" WHERE "status" = ANY($1) GROUP BY "status" ORDER BY count DESC LIMIT $2');
  assert.deepEqual(params, [["x'); DROP TABLE orders;--"], 100]);
});

test('mongo filters only use operators produced by the connector', () => {
  assert.deepEqual(toMongoFilter([{ field: 'status', op: 'eq', value: 'a' }, { field: 'amount', op: 'gte', value: 5 }]), { status: { $eq: 'a' }, amount: { $gte: 5 } });
  const pipeline = toMongoPipeline({ where: [], groupBy: ['status'], metrics: [{ op: 'avg', field: 'amount' }], limit: 10 });
  assert.deepEqual(pipeline.map((s) => Object.keys(s)[0]), ['$match', '$group', '$sort', '$limit']);
});

test('in-memory executor groups and aggregates', () => {
  const rows = [{ s: 'a', n: 1 }, { s: 'a', n: 3 }, { s: 'b', n: 10 }];
  const r = runInMemory(rows, { operation: 'aggregate', where: [], groupBy: ['s'], metrics: [{ op: 'avg', field: 'n' }], limit: 10 });
  assert.deepEqual(r.rows.find((x) => x.key.s === 'a'), { key: { s: 'a' }, count: 2, avg_n: 2 });
});

test('formula evaluator is arithmetic-only and null-safe', () => {
  const f = parseFormula('(price - cost) * sold');
  assert.deepEqual(f.fields, ['price', 'cost', 'sold']);
  assert.equal(f.evaluate({ price: 10, cost: 4, sold: 3 }), 18);
  assert.equal(f.evaluate({ price: 10, cost: null, sold: 3 }), null);
  assert.throws(() => parseFormula('process.exit()'));
  assert.throws(() => parseFormula('price; drop'));
});

test('intent, time and stemming helpers', () => {
  assert.equal(classifyIntent('Why are so many orders getting cancelled?'), 'investigation');
  assert.equal(classifyIntent('Which payment service has the highest failure rate?'), 'ranking');
  assert.equal(classifyIntent('How does the booking workflow work internally?'), 'technical');
  assert.equal(classifyIntent('When did API latency increase?'), 'trend');
  assert.deepEqual(extractTimeRange('sales in march 2025'), { from: '2025-03-01', to: '2025-03-31', label: 'march 2025' });
  assert.equal(stem('cancellation'), stem('cancelled'));
  assert.equal(stem('failure'), stem('failed'));
  assert.equal(stem('bookings'), stem('booking'));
  assert.deepEqual(tokenize('createdAt order_status'), tokenize('created at order status'));
});

test('analyzer finds stack, routes, models and auth with file references', () => {
  const a = analyzeProject([
    { path: 'package.json', content: JSON.stringify({ dependencies: { express: '4', mongoose: '8', jsonwebtoken: '9', react: '18' } }) },
    { path: 'server/routes/booking.js', content: "const router = require('express').Router();\nrouter.post('/bookings', requireAuth, create);\nrouter.get('/bookings/:id', show);" },
    { path: 'server/models/Booking.js', content: "const bookingSchema = new mongoose.Schema({\n  customer: String,\n  status: String,\n});\nmodule.exports = mongoose.model('Booking', bookingSchema);" },
    { path: 'server/middleware/auth.js', content: 'function requireAuth(req,res,next){ jwt.verify(token, secret) }' },
  ]);
  assert.deepEqual(a.stack.backend, ['Express']);
  assert.ok(a.stack.data.includes('MongoDB (Mongoose)'));
  assert.ok(a.routes.some((r) => r.method === 'POST' && r.path === '/bookings' && r.file === 'server/routes/booking.js' && r.line === 2));
  assert.deepEqual(a.models.map((m) => [m.name, m.fields]), [['Booking', ['customer', 'status']]]);
  assert.ok(a.auth.some((x) => x.symbol === 'jwt.verify'));
  assert.ok(a.entities.some((e) => e.name === 'booking'));
});

test('GitHub URL parsing', () => {
  assert.equal(parseRepoUrl('https://github.com/Prajwalkwr/UdyogConnect').fullName, 'Prajwalkwr/UdyogConnect');
  assert.equal(parseRepoUrl('git@github.com:a/b.git').fullName, 'a/b');
  assert.throws(() => parseRepoUrl('https://example.com/x'));
  const tree = parseRepoUrl('https://github.com/a/b/tree/feature/x?tab=readme');
  assert.equal(tree.fullName, 'a/b');
  assert.equal(tree.branch, 'feature/x');
  assert.equal(parseRepoUrl('https://github.com/a/b/').branch, null);
});

test('repository indexing includes application data, styles and deployment configuration but skips lockfiles', () => {
  for (const path of [
    'client/src/data/catalogSnapshot.json',
    'server/data/catalog.json',
    'client/src/App.css',
    'client/src/theme.scss',
    'render.yaml',
    'deployment/config.toml',
    '.gitignore',
  ]) assert.equal(isIndexable(path), true, `${path} should be indexed`);
  for (const path of ['package-lock.json', 'client/package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    assert.equal(isIndexable(path), false, `${path} should remain excluded`);
  }
});
