// Universal read-only connector for data that is only reachable over HTTP:
//   rest      — any JSON API (Supabase PostgREST, Firebase Realtime Database `.json`, custom APIs)
//   graphql   — a fixed, developer-registered query; `path` points at the result array
//   csv       — CSV exports, e.g. a Google Sheet published as CSV
//   firestore — Firestore REST documents (typed fields are decoded)
// Records are fetched (cached briefly) and queried in memory with the same query spec.
import { assertPublicUrl, fetchWithTimeout } from '../lib/netguard.js';
import { runInMemory, schemaFromCollections } from './dataset.js';

const MAX_ROWS = 10000;
const CACHE_MS = 60000;
const SOURCE_TIMEOUT_MS = Number(process.env.HTTP_SOURCE_TIMEOUT_MS) || 25000;
const cache = new Map();

const getPath = (obj, path) => (path ? path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj) : obj);

function flatten(record) {
  const out = {};
  for (const [k, v] of Object.entries(record || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) if (v2 === null || typeof v2 !== 'object') out[`${k}_${k2}`] = v2;
    } else if (!Array.isArray(v)) out[k] = v;
  }
  return out;
}

function toRecords(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.entries(value).map(([key, v]) => (v && typeof v === 'object' ? { _key: key, ...v } : { _key: key, value: v }));
  return [];
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  if (!header) return [];
  const keys = header.map((h) => h.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^(\d)/, '_$1') || 'column');
  return body.map((r) => Object.fromEntries(keys.map((k, i) => {
    const v = (r[i] ?? '').trim();
    return [k, v === '' ? null : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : /^(true|false)$/i.test(v) ? v.toLowerCase() === 'true' : v];
  })));
}

export function decodeFirestore(value) {
  if (!value || typeof value !== 'object') return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('referenceValue' in value) return value.referenceValue.split('/').pop();
  if ('mapValue' in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([k, v]) => [k, decodeFirestore(v)]));
  return null;
}

async function fetchCollection(source, { mode, headers = {} }) {
  const url = assertPublicUrl(source.url);
  if (mode === 'csv') {
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) throw new Error(`${source.name}: HTTP ${res.status}`);
    return parseCsv(await res.text());
  }
  if (mode === 'graphql') {
    const res = await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ query: source.query, variables: source.variables || {} }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.errors?.length) throw new Error(`${source.name}: ${body.errors?.[0]?.message || `HTTP ${res.status}`}`);
    return toRecords(getPath(body, source.path || 'data'));
  }
  if (mode === 'firestore') {
    const records = [];
    let pageToken = '';
    for (let page = 0; page < 20 && records.length < MAX_ROWS; page++) {
      const u = new URL(url);
      u.searchParams.set('pageSize', '300');
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const res = await fetchWithTimeout(u, { headers });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${source.name}: ${body.error?.message || `HTTP ${res.status}`}`);
      for (const doc of body.documents || []) records.push({ _id: doc.name.split('/').pop(), ...decodeFirestore({ mapValue: { fields: doc.fields } }) });
      if (!body.nextPageToken) break;
      pageToken = body.nextPageToken;
    }
    return records;
  }
  // Free-tier hosts (Render, Railway…) sleep when idle and can take ~30 s to wake.
  const get = () => fetchWithTimeout(url, { headers: { Accept: 'application/json', ...headers } }, SOURCE_TIMEOUT_MS);
  const res = await get().catch((e) => (e.name === 'AbortError' || /fetch failed/i.test(e.message) ? get() : Promise.reject(e)));
  const text = await res.text();
  if (!res.ok) throw new Error(`${source.name}: HTTP ${res.status}`);
  // Single-page apps answer unknown paths with their index.html; that is not an empty collection.
  if (/text\/html/i.test(res.headers.get('content-type') || '') || /^\s*(<!doctype\s+html|<html|<head|<body)/i.test(text)) {
    throw new Error(`${source.name}: returned an HTML page instead of JSON data`);
  }
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`${source.name}: returned content that is not JSON`); }
  return toRecords(getPath(body, source.path));
}

async function load(integration, { fresh = false } = {}) {
  const hit = cache.get(integration.id);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.collections;
  const { sources = [], mode = 'rest', headers } = integration.secrets;
  const collections = {};
  for (const source of sources) {
    collections[source.name] = (await fetchCollection(source, { mode, headers })).slice(0, MAX_ROWS).map(flatten);
  }
  cache.set(integration.id, { at: Date.now(), collections });
  return collections;
}

export const httpConnector = {
  label: 'HTTP / API source',
  async test(integration) {
    const start = Date.now();
    const cols = await load(integration, { fresh: true });
    return { ok: true, latencyMs: Date.now() - start, collections: Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.length])) };
  },
  async discoverSchema(integration) {
    return schemaFromCollections(await load(integration));
  },
  async query(integration, spec) {
    const cols = await load(integration);
    return runInMemory(cols[spec.collection] || [], spec);
  },
  async closeAll() { cache.clear(); },
};
