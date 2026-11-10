// Breadth tests: HTTP data sources (REST/Supabase, Firebase, Google Sheets CSV, GraphQL, Firestore),
// static websites, cross-collection analysis, approval-gated writes and multi-language code analysis.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { startApi } from './helpers.js';
import { analyzeProject } from '../apps/api/src/understanding/analyzer.js';
import { buildMysql } from '../apps/api/src/connectors/mysql.js';
import { parseCsv, decodeFirestore } from '../apps/api/src/connectors/http.js';
import { assertPublicUrl } from '../apps/api/src/lib/netguard.js';
import { validateSpec } from '../apps/api/src/connectors/querySpec.js';

const orders = Array.from({ length: 30 }, (_, i) => ({ id: i, status: i % 3 === 0 ? 'cancelled' : 'paid', cancel_reason: i % 3 === 0 ? (i % 2 ? 'late' : 'price') : null, total: 10 + i }));
const refunds = [];
let mock;
let base;

const pages = {
  '/': '<html><head><title>Lakeside Bakery</title></head><body><h1>Fresh bread every morning</h1><a href="/services">Services</a> <a href="/contact">Contact</a><p>We are a family bakery in Pokhara open since 1998.</p></body></html>',
  '/services': '<html><head><title>Services</title></head><body><h2>Custom cakes</h2><p>We offer custom birthday cakes and wedding cakes with 3 days notice.</p><p>Catering is available for events of up to 200 guests.</p></body></html>',
  '/contact': '<html><head><title>Contact us</title></head><body><form action="/send" method="post"><input name="fullName"><input name="email"><textarea name="message"></textarea></form><p>Call us at 061-555-123 between 7am and 6pm.</p></body></html>',
};

before(async () => {
  mock = http.createServer((req, res) => {
    const json = (v, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/rest/v1/orders') return req.headers.apikey === 'anon-key' ? json(orders) : json({ message: 'no key' }, 401);
      if (url.pathname === '/rtdb/users.json') return json({ u1: { name: 'Asha', plan: 'pro', active: true }, u2: { name: 'Bikash', plan: 'free', active: false }, u3: { name: 'Chandra', plan: 'pro', active: true } });
      if (url.pathname === '/sheet.csv') { res.writeHead(200, { 'Content-Type': 'text/csv' }); return res.end('Region,Month,Revenue\nNorth,Jan,1200\nSouth,Jan,800\n"East, Coast",Jan,1500\n'); }
      if (url.pathname === '/graphql') {
        const { query } = JSON.parse(body || '{}');
        return query?.includes('products') ? json({ data: { products: [{ name: 'Tea', stock: 0 }, { name: 'Coffee', stock: 5 }, { name: 'Honey', stock: 0 }] } }) : json({ errors: [{ message: 'bad query' }] });
      }
      if (url.pathname === '/firestore/tickets') {
        return json({ documents: [
          { name: 'p/d/tickets/t1', fields: { priority: { stringValue: 'high' }, status: { stringValue: 'open' }, hours: { integerValue: '5' } } },
          { name: 'p/d/tickets/t2', fields: { priority: { stringValue: 'low' }, status: { stringValue: 'closed' }, hours: { integerValue: '1' } } },
        ] });
      }
      if (url.pathname.startsWith('/refund/') && req.method === 'POST') { refunds.push({ orderId: url.pathname.split('/')[2], body: JSON.parse(body || '{}'), key: req.headers['idempotency-key'] }); return json({ refunded: true }); }
      if (pages[url.pathname]) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(pages[url.pathname]); }
      json({ error: 'not found' }, 404);
    });
  });
  await new Promise((r) => mock.listen(0, r));
  base = `http://127.0.0.1:${mock.address().port}`;
});

after(() => mock.close());

describe('connectors for any backend', () => {
  let api;
  let token;
  let p;
  before(async () => {
    api = await startApi();
    token = await api.user('any@example.com');
    p = await api.project(token, 'Any Backend');
  });
  after(() => api.close());

  const add = async (body) => {
    const r = await api.call('POST', `/api/v1/projects/${p.id}/integrations`, { token, body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.health.ok, true, JSON.stringify(r.body.health));
    return r.body.integration;
  };
  const ask = async (question) => (await api.call('POST', `/api/v1/projects/${p.id}/ask`, { token, body: { question } })).body;

  test('Supabase-style REST API with an API key header', async () => {
    const it = await add({ type: 'http', name: 'Supabase', config: { mode: 'rest', headers: { apikey: 'anon-key' }, sources: [{ name: 'orders', url: `${base}/rest/v1/orders` }] } });
    assert.ok(!JSON.stringify(it).includes('anon-key'));
    const r = await ask('Why are orders getting cancelled?');
    assert.ok(r.calculations.some((c) => c.inputs === '10 / 30'), JSON.stringify(r.calculations));
    assert.ok(r.findings.some((f) => f.text.includes('cancel_reason')));
  });

  test('Firebase Realtime Database (object of objects)', async () => {
    await add({ type: 'http', name: 'Firebase RTDB', config: { mode: 'rest', sources: [{ name: 'users', url: `${base}/rtdb/users.json` }] } });
    const r = await ask('How many users are on each plan?');
    assert.ok(r.findings.some((f) => f.text.includes('pro 2') && f.text.includes('free 1')), r.findings.map((f) => f.text).join('\n'));
  });

  test('Google Sheets published as CSV', async () => {
    await add({ type: 'http', name: 'Sheet', config: { mode: 'csv', sources: [{ name: 'sales', url: `${base}/sheet.csv` }] } });
    const r = await ask('Which sales region has the highest revenue?');
    assert.ok(r.findings.some((f) => f.text.includes('East, Coast 1,500')), r.findings.map((f) => f.text).join('\n'));
  });

  test('GraphQL with a fixed read-only query; mutations are rejected', async () => {
    const bad = await api.call('POST', `/api/v1/projects/${p.id}/integrations`, { token, body: { type: 'http', name: 'GQL', config: { mode: 'graphql', sources: [{ name: 'products', url: `${base}/graphql`, query: 'mutation { deleteAll }' }] } } });
    assert.equal(bad.status, 400);
    await add({ type: 'http', name: 'GraphQL', config: { mode: 'graphql', sources: [{ name: 'products', url: `${base}/graphql`, query: '{ products { name stock } }', path: 'data.products' }] } });
    await api.call('POST', `/api/v1/projects/${p.id}/definitions`, { token, body: { term: 'out of stock', meaning: 'No stock left', collection: 'products', where: [{ field: 'stock', op: 'lte', value: 0 }] } });
    const r = await ask('Which products are out of stock?');
    assert.ok(r.findings.some((f) => f.text.includes('Tea') && f.text.includes('Honey') && !f.text.includes('Coffee')));
  });

  test('Firestore REST documents are decoded', async () => {
    await add({ type: 'http', name: 'Firestore', config: { mode: 'firestore', sources: [{ name: 'tickets', url: `${base}/firestore/tickets` }] } });
    const r = await ask('What is the average hours for tickets?');
    assert.ok(r.findings.some((f) => f.text.includes('average 3')), r.findings.map((f) => f.text).join('\n'));
  });
});

describe('static websites', () => {
  let api;
  let token;
  let p;
  before(async () => {
    api = await startApi();
    token = await api.user('site@example.com');
    p = await api.project(token, 'Bakery Site');
    const r = await api.call('POST', `/api/v1/projects/${p.id}/connect/website`, { token, body: { url: `${base}/` } });
    assert.equal(r.status, 202);
    const job = await api.waitForJob(token, p.id, r.body.job.id);
    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.result.site.pages, 3);
  });
  after(() => api.close());

  test('answers from page content with page references', async () => {
    const { body } = await api.call('POST', `/api/v1/projects/${p.id}/ask`, { token, body: { question: 'Do you offer wedding cakes?' } });
    assert.equal(body.status, 'success');
    assert.ok(body.findings[0].text.includes('wedding cakes') && body.findings[0].text.includes('site/services.html'), body.findings[0]?.text);
    assert.ok(!body.limitations.some((l) => /major/.test(l)));
  });

  test('describes pages and forms', async () => {
    const { body } = await api.call('POST', `/api/v1/projects/${p.id}/ask`, { token, body: { question: 'What does the contact form ask for?' } });
    assert.ok(body.findings.some((f) => f.text.includes('POST /send with fields fullName, email, message')), body.findings.map((f) => f.text).join('\n'));
  });
});

describe('cross-collection analysis', () => {
  let api;
  let token;
  let p;
  before(async () => {
    api = await startApi();
    token = await api.user('cross@example.com');
    p = await api.project(token, 'Ops');
    const transactions = Array.from({ length: 200 }, (_, i) => {
      const gateway = ['Alpha', 'Beta'][i % 2];
      const day = 1 + Math.floor(i / 20);
      const failed = gateway === 'Beta' && day === 5 ? i % 4 !== 0 : i % 10 === 0;
      return { gateway, status: failed ? 'failed' : 'ok', createdAt: `2026-03-${String(day).padStart(2, '0')}T${String(i % 20).padStart(2, '0')}:00:00Z` };
    });
    const incidents = [
      { summary: 'Beta bank outage', service: 'Beta', createdAt: '2026-03-05T00:00:00Z', durationMin: 1440 },
      { summary: 'Alpha slow callbacks', service: 'Alpha', createdAt: '2026-03-08T00:00:00Z', durationMin: 120 },
    ];
    await api.call('POST', `/api/v1/projects/${p.id}/integrations`, { token, body: { type: 'dataset', name: 'Ops data', synthetic: true, collections: { transactions, incidents } } });
  });
  after(() => api.close());

  test('links incidents to transactions by key and time window', async () => {
    const { body } = await api.call('POST', `/api/v1/projects/${p.id}/ask`, { token, body: { question: 'Which incidents are affecting transaction failures?' } });
    const f = body.findings.find((x) => x.text.startsWith('Cross-collection'));
    assert.ok(f, body.findings.map((x) => x.text).join('\n'));
    assert.ok(/during incidents "Beta bank outage" \(gateway = "Beta"\), 2026-03-05 00:00 → 2026-03-06 00:00: 100% \(10\/10\) vs 0% outside it/.test(f.text), f.text);
    assert.ok(f.text.includes('not proven cause'));
    assert.ok(body.plan.some((s) => s.action === 'relate'));
  });
});

describe('approval-gated write actions', () => {
  let api;
  let token;
  let p;
  let tool;
  before(async () => {
    api = await startApi();
    token = await api.user('writer@example.com');
    p = await api.project(token, 'Shop Actions');
    const r = await api.call('POST', `/api/v1/projects/${p.id}/tools`, { token, body: { name: 'refund_order', description: 'Refund an order to the customer', method: 'POST', url: `${base}/refund/{orderId}`, parameters: ['reason'] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    tool = r.body.tool;
    assert.equal(tool.requiresApproval, true);
    assert.deepEqual(tool.requiredParameters, ['orderId']);
  });
  after(() => api.close());

  test('the engine proposes but never executes', async () => {
    const { body } = await api.call('POST', `/api/v1/projects/${p.id}/ask`, { token, body: { question: 'Refund order o12 please' } });
    assert.equal(body.proposedActions[0].tool, 'refund_order');
    assert.deepEqual(body.proposedActions[0].params, { orderId: 'o12' });
    assert.equal(refunds.length, 0);
  });

  test('direct execution and public keys are refused', async () => {
    assert.equal((await api.call('POST', `/api/v1/projects/${p.id}/tools/${tool.id}/execute`, { token, body: { params: { orderId: 'o1' } } })).status, 403);
    assert.equal((await api.call('POST', `/api/v1/projects/${p.id}/actions`, { headers: { 'X-Project-Key': p.publicKey }, body: { toolId: tool.id, params: { orderId: 'o1' } } })).status, 403);
    assert.equal((await api.call('POST', `/api/v1/projects/${p.id}/actions`, { token, body: { toolId: tool.id, params: { orderId: 'o1', amount: 5 } } })).status, 400);
    assert.equal(refunds.length, 0);
  });

  test('approve executes exactly once and is audited', async () => {
    const req = await api.call('POST', `/api/v1/projects/${p.id}/actions`, { headers: { 'X-Secret-Key': p.secretKey }, body: { toolId: tool.id, params: { orderId: 'o12', reason: 'damaged' }, reason: 'customer request' } });
    assert.equal(req.status, 201);
    assert.equal(req.body.action.status, 'pending');
    assert.equal((await api.call('POST', `/api/v1/projects/${p.id}/actions/${req.body.action.id}/approve`, { headers: { 'X-Secret-Key': p.secretKey } })).status, 403, 'only a signed-in owner may approve');
    const ok = await api.call('POST', `/api/v1/projects/${p.id}/actions/${req.body.action.id}/approve`, { token });
    assert.equal(ok.body.action.status, 'executed');
    assert.deepEqual(refunds, [{ orderId: 'o12', body: { reason: 'damaged' }, key: req.body.action.id }]);
    assert.equal((await api.call('POST', `/api/v1/projects/${p.id}/actions/${req.body.action.id}/approve`, { token })).status, 409);
    const logs = await api.call('GET', `/api/v1/projects/logs?projectId=${p.id}`, { token });
    assert.deepEqual(logs.body.audit.filter((a) => a.action.startsWith('action.')).map((a) => a.action).reverse(), ['action.request', 'action.execute']);
  });
});

describe('code analysis across languages', () => {
  const a = analyzeProject([
    { path: 'composer.json', content: '{"require":{"laravel/framework":"^11.0","laravel/sanctum":"^4"}}' },
    { path: 'routes/api.php', content: "<?php\nRoute::get('/orders', [OrderController::class, 'index']);\nRoute::post('/orders/{id}/refund', [OrderController::class, 'refund'])->middleware('auth:sanctum');" },
    { path: 'app/Models/Order.php', content: '<?php\nclass Order extends Model {}' },
    { path: 'pom.xml', content: '<artifactId>spring-boot-starter-web</artifactId><artifactId>spring-boot-starter-data-jpa</artifactId>' },
    { path: 'src/main/java/OrderController.java', content: '@RestController\nclass C {\n  @GetMapping("/api/invoices")\n  List<Invoice> all() {}\n  @PostMapping(value = "/api/invoices")\n  void add() {}\n}' },
    { path: 'src/main/java/Invoice.java', content: '@Entity\npublic class Invoice { }' },
    { path: 'Gemfile', content: "gem 'rails', '~> 7.1'\ngem 'devise'" },
    { path: 'config/routes.rb', content: "Rails.application.routes.draw do\n  resources :bookings\n  get '/health', to: 'health#show'\nend" },
    { path: 'app/models/booking.rb', content: 'class Booking < ApplicationRecord\nend' },
    { path: 'Api.csproj', content: '<Project Sdk="Microsoft.NET.Sdk.Web"><PackageReference Include="Microsoft.EntityFrameworkCore" /></Project>' },
    { path: 'Program.cs', content: 'app.MapGet("/api/tickets", () => db.Tickets);\nclass Db { public DbSet<Ticket> Tickets { get; set; } }\n[Authorize]\nclass X {}' },
    { path: 'go.mod', content: 'require github.com/gin-gonic/gin v1.9.1\nrequire gorm.io/gorm v1.25.0' },
    { path: 'main.go', content: 'r := gin.Default()\nr.GET("/api/payments", list)\nr.POST("/api/payments", create)\ntype Payment struct {\n  gorm.Model\n}' },
    { path: 'shop/urls.py', content: "urlpatterns = [\n    path('cart/', views.cart),\n]" },
  ]);
  const has = (method, path) => a.routes.some((r) => r.method === method && r.path === path);

  test('routes from PHP, Java, Ruby, C#, Go and Django', () => {
    assert.ok(has('GET', '/orders') && has('POST', '/orders/{id}/refund'), 'laravel');
    assert.ok(has('GET', '/api/invoices') && has('POST', '/api/invoices'), 'spring');
    assert.ok(has('RESOURCE', '/bookings') && has('GET', '/health'), 'rails');
    assert.ok(has('GET', '/api/tickets'), '.net');
    assert.ok(has('GET', '/api/payments') && has('POST', '/api/payments'), 'go');
    assert.ok(has('ANY', '/cart/'), 'django');
  });

  test('models, frameworks and auth', () => {
    assert.deepEqual(['Order', 'Invoice', 'Booking', 'Ticket', 'Payment'].filter((m) => !a.models.some((x) => x.name === m)), []);
    for (const fw of ['Laravel', 'Spring Boot', 'Ruby on Rails', 'ASP.NET Core', 'Gin']) assert.ok(a.stack.backend.includes(fw), fw);
    assert.ok(a.stack.languages.includes('PHP') && a.stack.languages.includes('C#') && a.stack.languages.includes('Ruby'));
    assert.ok(a.auth.some((x) => x.symbol.startsWith('[Authorize')) && a.auth.some((x) => x.symbol.includes("middleware('auth")));
  });
});

describe('connector units', () => {
  test('MySQL SQL is parameterised and backtick-quoted', () => {
    const schema = { orders: { fields: [{ name: 'status' }, { name: 'total' }] } };
    const spec = validateSpec({ operation: 'aggregate', collection: 'orders', groupBy: ['status'], metrics: [{ op: 'avg', field: 'total' }], where: [{ field: 'status', op: 'in', value: ['a', "b'; DROP TABLE x"] }] }, {}, schema);
    assert.deepEqual(buildMysql(spec), { text: 'SELECT `status`, COUNT(*) AS count, AVG(`total`) AS `avg_total` FROM `orders` WHERE `status` IN (?, ?) GROUP BY `status` ORDER BY count DESC LIMIT 100', params: ['a', "b'; DROP TABLE x"] });
  });

  test('CSV parsing and Firestore decoding', () => {
    assert.deepEqual(parseCsv('a,b c\n"x, y",2\n'), [{ a: 'x, y', b_c: 2 }]);
    assert.deepEqual(decodeFirestore({ mapValue: { fields: { n: { integerValue: '3' }, t: { booleanValue: true } } } }), { n: 3, t: true });
  });

  test('private network URLs are blocked by default', () => {
    const prev = process.env.ALLOW_PRIVATE_NETWORK;
    process.env.ALLOW_PRIVATE_NETWORK = 'false';
    for (const u of ['http://127.0.0.1/x', 'http://localhost:3000', 'http://169.254.169.254/latest', 'http://10.0.0.5', 'file:///etc/passwd']) assert.throws(() => assertPublicUrl(u), u);
    assert.doesNotThrow(() => assertPublicUrl('https://api.example.com/v1'));
    process.env.ALLOW_PRIVATE_NETWORK = prev;
  });
});
