// Live end-to-end check of Google Search grounding: starts the API on a temporary data directory
// with a sample UdyogConnect project (docs, a businesses dataset, a local website), asks the seven
// routing questions over HTTP and checks which source answered each one. Makes real Gemini calls
// (up to four grounded requests). Your own data directory is not touched.
// Usage (from contextai/): node apps/api/scripts/test-google-search.js
import dotenv from 'dotenv';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
// The same files the API server reads (src/index.js run from apps/api).
dotenv.config({ path: path.resolve(here, '../../../.env') });
dotenv.config({ path: path.resolve(here, '../.env') });

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set. Add it to contextai/apps/api/.env or contextai/.env (see .env.example) and run again.');
  process.exit(1);
}
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'contextai-google-search-'));
process.env.JWT_SECRET ||= 'live-search-test-secret-at-least-32-characters';
process.env.ENCRYPTION_KEY ||= 'live-search-test-encryption-key-32chars';
process.env.EMBEDDINGS_ENABLED = 'false';
process.env.ALLOW_PRIVATE_NETWORK = 'true';
process.env.RATE_LIMIT_MAX = '10000';
process.env.ASK_RATE_LIMIT_MAX = '10000';

const { createApp } = await import('../src/app.js');
const { googleSearch } = await import('../src/lib/googleSearch.js');
const { llm } = await import('../src/lib/llm.js');
const { closeAllConnections } = await import('../src/connectors/index.js');

const site = http.createServer((req, res) => {
  if (req.url === '/api/health') { res.setHeader('Content-Type', 'application/json'); res.end('{"status":"ok","database":"connected"}'); return; }
  res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>UdyogConnect</title><h1>UdyogConnect</h1>');
}).listen(0);
const server = createApp().listen(0);
await Promise.all([site, server].map((s) => new Promise((r) => (s.listening ? r() : s.once('listening', r)))));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;

async function call(method, url, body, token) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

const { token } = await call('POST', '/auth/register', { email: `live-${Date.now()}@example.com`, password: 'password123' });
const { project } = await call('POST', '/projects', { name: 'UdyogConnect' }, token);
await call('PATCH', `/projects/${project.id}`, { description: 'Marketplace connecting customers with local businesses in Nepal.', websiteUrl: `http://127.0.0.1:${site.address().port}` }, token);
const { job } = await call('POST', `/projects/${project.id}/knowledge/index`, { files: [
  { path: 'README.md', content: '# UdyogConnect\nUdyogConnect is a marketplace that connects customers with local businesses in Nepal. Customers discover nearby businesses, order products and book services.' },
  { path: 'docs/payments.md', content: '## Payments\nUdyogConnect supports cash on delivery and eSewa wallet payments.' },
] }, token);
for (let i = 0; i < 100; i++) {
  const { jobs } = await call('GET', `/projects/${project.id}/jobs`, null, token);
  if (['completed', 'failed'].includes(jobs.find((j) => j.id === job.id)?.status)) break;
  await new Promise((r) => setTimeout(r, 100));
}
await call('POST', `/projects/${project.id}/integrations`, { type: 'dataset', name: 'Live API', collections: { businesses: [
  { _id: 'b1', name: 'Himalayan Momo House', category: 'Restaurant', rating: 4.8, reviewCount: 5 },
  { _id: 'b2', name: 'Kathmandu Tailors', category: 'Clothing', rating: 4.5, reviewCount: 2 },
  { _id: 'b3', name: 'Lalitpur Bakery', category: 'Restaurant', rating: 4.2, reviewCount: 5 },
] } }, token);

const web = (r) => r.webSearch?.searched && r.citations.length > 0;
const noWeb = (r) => !r.webSearch && !r.route.sources.includes('web_search');
const cases = [
  { q: 'How many moons does Mars have?', expect: 'general knowledge (search optional)', ok: (r) => r.status === 'success' && !r.route.sources.some((s) => ['project_knowledge', 'live_data'].includes(s)) },
  { q: 'What is the latest AI news?', expect: 'Google Search', ok: web },
  { q: 'What is the latest React version?', expect: 'Google Search', ok: web },
  { q: 'What happened in the technology industry this week?', expect: 'Google Search', ok: web },
  { q: 'What is UdyogConnect?', expect: 'project knowledge', ok: (r) => noWeb(r) && r.route.sources.includes('project_knowledge') },
  { q: 'Which business has the highest rating?', expect: 'backend database', ok: (r) => noWeb(r) && r.route.sources.includes('live_data') && /Himalayan Momo House/.test(r.answer) },
  { q: 'What is the current website status?', expect: 'live health check', ok: (r) => noWeb(r) && r.answerMode === 'health_check' },
];

console.log(`Main model: ${llm.isEnabled() ? `${llm.provider()} ${llm.model('answer')}` : 'none (Gemini answers general questions)'}`);
console.log(`Gemini: ${JSON.stringify(googleSearch.status().models)}\n`);
let failed = 0;
for (const [i, c] of cases.entries()) {
  const started = Date.now();
  let r;
  try { r = await call('POST', `/projects/${project.id}/ask`, { question: c.q }, token); } catch (e) { r = { error: e.message, route: { sources: [] }, citations: [] }; }
  const pass = !r.error && c.ok(r);
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${i + 1}. ${c.q}`);
  console.log(`     expected: ${c.expect} | sources: ${r.route.sources.join(', ') || '-'} | mode: ${r.answerMode || '-'} | status: ${r.status || r.error} | ${Date.now() - started} ms`);
  if (r.webSearch) console.log(`     gemini: ${r.webSearch.model}${r.webSearch.fallbackFrom ? ` (fallback from ${r.webSearch.fallbackFrom})` : ''}, searched=${r.webSearch.searched}, queries=${JSON.stringify(r.webSearch.queries)}, suggestions=${r.searchSuggestions ? 'yes' : 'no'}`);
  console.log(`     answer: ${String(r.answer || '').replace(/\s+/g, ' ').slice(0, 400)}`);
  (r.citations || []).slice(0, 5).forEach((s) => console.log(`       [${s.index ?? '-'}] ${s.title} — ${s.url}`));
  (r.limitations || []).forEach((l) => console.log(`     limitation: ${l}`));
  console.log('');
}
console.log(`Google Search today: ${JSON.stringify(googleSearch.status().today)}`);
console.log(failed ? `${failed} of ${cases.length} checks failed.` : `All ${cases.length} checks passed.`);

server.close(); site.close(); await closeAllConnections();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
