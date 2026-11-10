// Live health of a connected application, measured against its own services: the website, the
// backend's JSON health endpoints, the database those endpoints report, and connected data sources.
// An HTML page is never a health report: single-page apps answer every unknown path (/health,
// /status) with index.html and HTTP 200, which says nothing about the backend.
import { db } from '../lib/db.js';
import { assertPublicUrl, fetchWithTimeout } from '../lib/netguard.js';
import { testIntegration } from '../connectors/index.js';

const TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS) || 12000;
const CACHE_MS = Number(process.env.HEALTH_CACHE_MS) || 30000;
const MAX_ENDPOINTS = 6;
const cache = new Map();

const UP = /^(ok|up|healthy|pass(ed|ing)?|operational|online|running|connected|available|ready|alive|green|good|true|success)$/i;
const DEGRADED = /^(degraded|warn(ing)?|partial|slow|limited|yellow|maintenance)$/i;
const DOWN = /^(down|error|errored|fail(ed|ing|ure)?|unhealthy|offline|disconnected|not[ _-]?connected|unavailable|unreachable|red|critical|false)$/i;
// Storage a backend uses when its real database is missing (development fallbacks).
const FALLBACK_STORAGE = /\b(file|json|memory|in-memory|mock|local|development|dev)\b/i;
const HEALTH_PATH = /(^|\/)(health|healthz|status|ping|ready|readyz|live|livez)(\/|$)/i;
const DEFAULT_PATHS = ['/api/health', '/healthz', '/health', '/api/status', '/status'];

export function looksLikeHtml(contentType, body) {
  return /text\/html|application\/xhtml/i.test(contentType || '') || /^\s*(<!doctype\s+html|<html|<head|<body)/i.test(body || '');
}

const stateOf = (v) => {
  if (typeof v === 'boolean') return v ? 'up' : 'down';
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return UP.test(s) ? 'up' : DEGRADED.test(s) ? 'degraded' : DOWN.test(s) ? 'down' : null;
};
const firstState = (o, keys) => {
  for (const k of keys) {
    const s = stateOf(o?.[k]);
    if (s) return s;
  }
  return null;
};

// Reads any JSON health payload: {status}, {ok}, {server, database}, {checks: {...}}, {services: {...}}.
export function interpretHealth(json) {
  const out = { backend: null, databases: [], services: {}, counts: {} };
  if (!json || typeof json !== 'object' || Array.isArray(json)) return out;
  out.backend = firstState(json, ['status', 'state', 'health', 'server', 'api', 'app', 'overall', 'ok', 'healthy', 'up', 'success']);
  for (const [k, v] of Object.entries(json)) {
    if (/Count$/.test(k) && typeof v === 'number') out.counts[k] = v;
    if (!/^(database|db|mongo(db)?|postgres(ql)?|mysql|sql|datastore|storage|redis)$/i.test(k)) continue;
    if (v && typeof v === 'object') {
      const type = [v.type, v.engine, v.driver, v.name].find((x) => typeof x === 'string') || null;
      out.databases.push({ key: k, state: firstState(v, ['status', 'state', 'connected', 'ok', 'healthy']), type, fallback: !!type && FALLBACK_STORAGE.test(type) });
      for (const [ck, cv] of Object.entries(v)) if (/Count$/.test(ck) && typeof cv === 'number') out.counts[ck] = cv;
    } else {
      out.databases.push({ key: k, state: stateOf(v), type: null, fallback: false });
    }
  }
  const services = json.services || json.checks || json.components || json.dependencies || json.integrations;
  if (services && typeof services === 'object' && !Array.isArray(services)) {
    for (const [name, v] of Object.entries(services)) {
      const state = v && typeof v === 'object' ? firstState(v, ['status', 'state', 'connected', 'ok', 'healthy']) : stateOf(v);
      if (!state) continue;
      if (/^(database|db|mongo(db)?|postgres(ql)?|mysql|storage)$/i.test(name)) {
        const type = v && typeof v === 'object' ? [v.type, v.engine].find((x) => typeof x === 'string') || null : null;
        out.databases.push({ key: name, state, type, fallback: !!type && FALLBACK_STORAGE.test(type) });
      } else {
        out.services[name] = { state, detail: v && typeof v === 'object' ? String(v.message || v.error || v.detail || '').slice(0, 160) || null : null };
      }
    }
  }
  return out;
}

export function websiteUrlOf(project, profile) {
  return project.websiteUrl || profile?.website?.url || null;
}

// The configured status URL first, then health routes declared in the indexed backend code, then
// conventional paths, each resolved against the site (proxied APIs) and the configured API base.
export function healthCandidates(project, profile) {
  const out = [];
  const add = (u, base) => {
    try {
      const s = new URL(u, base).toString();
      if (!out.includes(s)) out.push(s);
    } catch { /* not a URL */ }
  };
  if (project.statusUrl) add(project.statusUrl);
  const origins = [project.apiUrl, websiteUrlOf(project, profile)].filter(Boolean);
  const declared = [...new Set((profile?.architecture?.routes || [])
    .filter((r) => (r.method || 'GET').toUpperCase() === 'GET' && HEALTH_PATH.test(r.path) && !/[:{*]/.test(r.path))
    .map((r) => r.path))].slice(0, 4);
  for (const origin of origins) for (const p of [...declared, ...DEFAULT_PATHS]) add(p, origin);
  return out.slice(0, MAX_ENDPOINTS + 2);
}

async function probe(url, accept) {
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(assertPublicUrl(url), { headers: { Accept: accept, 'User-Agent': 'ContextAI-health/1.0' } }, TIMEOUT_MS);
    const body = (await res.text()).slice(0, 100000);
    return { url, ok: res.ok, httpStatus: res.status, contentType: res.headers.get('content-type') || '', body, latencyMs: Date.now() - started };
  } catch (e) {
    return { url, ok: false, error: e.name === 'AbortError' ? `no response within ${Math.round(TIMEOUT_MS / 1000)} s` : e.message, latencyMs: Date.now() - started };
  }
}

async function checkWebsite(url) {
  if (!url) return { state: 'not_configured' };
  const r = await probe(url, 'text/html,*/*');
  const title = r.body?.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.trim() || null;
  if (r.error) return { state: 'down', url, error: r.error, latencyMs: r.latencyMs };
  return { state: r.ok ? 'up' : 'down', url, httpStatus: r.httpStatus, latencyMs: r.latencyMs, title, error: r.ok ? null : `HTTP ${r.httpStatus}` };
}

async function checkBackend(candidates) {
  const probes = await Promise.all(candidates.map((u) => probe(u, 'application/json')));
  const endpoints = [];
  const rejected = [];
  for (const p of probes) {
    if (p.error) { rejected.push({ url: p.url, reason: p.error }); continue; }
    if (looksLikeHtml(p.contentType, p.body)) { rejected.push({ url: p.url, reason: `returned an HTML page (HTTP ${p.httpStatus}), not a health report` }); continue; }
    // A JSON 404 ("route not found") proves the API answers, not that this path reports health.
    if ([401, 403, 404, 405].includes(p.httpStatus)) { rejected.push({ url: p.url, reason: `HTTP ${p.httpStatus}: not a health endpoint` }); continue; }
    let json;
    try { json = JSON.parse(p.body); } catch { rejected.push({ url: p.url, reason: `returned non-JSON content (${p.contentType || 'unknown type'})` }); continue; }
    if (!json || typeof json !== 'object' || Array.isArray(json)) { rejected.push({ url: p.url, reason: 'returned JSON that is not a health object' }); continue; }
    const reading = interpretHealth(json);
    endpoints.push({ url: p.url, httpStatus: p.httpStatus, latencyMs: p.latencyMs, reading: { ...reading, backend: reading.backend || (p.ok ? 'up' : 'down') } });
  }
  const unreachable = probes.length > 0 && probes.every((p) => p.error);
  if (!endpoints.length) {
    return { state: unreachable ? 'down' : 'unknown', endpoints, rejected, error: unreachable ? probes[0].error : null };
  }
  const states = endpoints.map((e) => e.reading.backend);
  const state = states.includes('down') ? 'down' : states.includes('degraded') ? 'degraded' : 'up';
  return { state, endpoints, rejected };
}

// Several endpoints can describe the same database differently ("disconnected" in one, "JSON file
// storage, connected" in another); together they mean the primary database is down and a fallback serves.
function combineDatabase(endpoints) {
  const reports = endpoints.flatMap((e) => e.reading.databases.map((d) => ({ ...d, url: e.url })));
  if (!reports.length) return { state: 'unknown', reports };
  const fallback = reports.find((d) => d.fallback && d.state !== 'down');
  const down = reports.find((d) => d.state === 'down');
  if (down && fallback) return { state: 'degraded', primary: 'disconnected', fallbackType: fallback.type, reports };
  if (fallback) return { state: 'degraded', primary: 'not_in_use', fallbackType: fallback.type, reports };
  if (down) return { state: 'down', primary: 'disconnected', reports };
  if (reports.some((d) => d.state === 'degraded')) return { state: 'degraded', reports };
  if (reports.some((d) => d.state === 'up')) return { state: 'up', type: reports.find((d) => d.type)?.type || null, reports };
  return { state: 'unknown', reports };
}

async function checkIntegrations(project, endpoints) {
  const items = [];
  for (const i of db.listIntegrations(project.id)) {
    const h = await testIntegration(i).catch((e) => ({ ok: false, error: e.message }));
    items.push({ name: i.name, kind: 'data_source', state: h.ok ? 'up' : 'down', error: h.ok ? null : String(h.error || '').slice(0, 160), latencyMs: h.latencyMs ?? null });
  }
  for (const e of endpoints) {
    for (const [name, s] of Object.entries(e.reading.services)) {
      if (!items.some((x) => x.name === name)) items.push({ name, kind: 'reported_by_application', state: s.state, error: s.state === 'up' ? null : s.detail });
    }
  }
  const state = !items.length ? 'none' : items.some((x) => x.state === 'down') ? 'down' : items.some((x) => x.state === 'degraded') ? 'degraded' : 'up';
  return { state, items };
}

export async function checkProjectHealth(project, { fresh = false } = {}) {
  const hit = cache.get(project.id);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const profile = db.getProfile(project.id);
  const websiteUrl = websiteUrlOf(project, profile);
  const candidates = healthCandidates(project, profile);
  const [website, backend] = await Promise.all([checkWebsite(websiteUrl), checkBackend(candidates)]);
  const database = combineDatabase(backend.endpoints);
  const integrations = await checkIntegrations(project, backend.endpoints);
  const counts = Object.assign({}, ...backend.endpoints.map((e) => e.reading.counts));

  let overall;
  if (website.state === 'down' && backend.state === 'down') overall = 'down';
  else if (website.state === 'down' || backend.state === 'down') overall = 'partial_outage';
  else if (database.state === 'down' || database.state === 'degraded' || backend.state === 'degraded' || integrations.state === 'down' || integrations.state === 'degraded') overall = 'degraded';
  else if (backend.state === 'unknown' || website.state === 'not_configured') overall = 'unverified';
  else overall = 'healthy';

  const result = { overall, checkedAt: new Date().toISOString(), website, backend, database, integrations, counts, primaryDatabase: (profile?.architecture?.stack?.data || [])[0] || null };
  cache.set(project.id, { at: Date.now(), result });
  db.addAudit({ projectId: project.id, actor: 'system:health', action: 'health.check', target: overall, status: 'success' });
  return result;
}

export const clearHealthCache = () => cache.clear();

// "Is the database connected?" → database; "Is the website online?" → website; "any outages?" → overall.
export function healthFocus(question) {
  const q = question.toLowerCase();
  const asks = /\b(status|health|healthy|up|down|online|offline|working|running|reachable|available|unavailable|connected|disconnected|operational|outages?|incidents?|issues?|problems?|failing|broken|live)\b/;
  if (!asks.test(q)) return null;
  // "status of my order", "is the product available?" are about records, not service health.
  if (/\bmy\b/.test(q) || /\b(orders?|bookings?|payments?|refunds?|deliver(y|ies)|products?|items?|business(es)?|shops?|stores?|restaurants?|applications?\s+for)\b/.test(q)) return null;
  if (/^\s*(what|how)\s+(happens|would happen|should happen)\b/.test(q) || /\bwhen\s+(the\s+)?\w+\s+(is|are|goes)\s+(down|unavailable|offline)\b/.test(q)) return null;
  // "the current status of the Artemis mission" is about something else, not this application.
  const subject = q.match(/\bstatus\s+(?:of|for|on)\s+(.+)/)?.[1];
  if (subject && !/^(?:(?:this|the|your|our)\s+)?(?:site|website|web ?app|app|application|platform|service|system|server|backend|api|database|db|integrations?|everything|it)\b/.test(subject)) return null;
  if (/\b(integrations?|third[- ]party|external\s+(services?|apis?)|data\s+sources?|connectors?)\b/.test(q)) return 'integrations';
  if (/\b(database|db|mongo(db)?|postgres|mysql|storage)\b/.test(q)) return 'database';
  if (/\b(backend|server|api)\b/.test(q)) return 'backend';
  if (/\b(website|site|homepage|frontend|web ?page|web ?app)\b/.test(q) && /\b(online|offline|up|down|reachable|available|unavailable|working|loading|live|status|health|healthy)\b/.test(q)) return 'website';
  if (/\b(current|system|service|overall|platform)\s+status\b|\bwhat\s+(is|'s)\s+the\s+(current\s+)?status\b|\bstatus\s+(of|for)\s+(this|the)\b|\bhealth(check|y)?\b|\b(outages?|incidents?|downtime)\b|\b(is|are)\s+(the\s+|this\s+)?(site|app|application|platform|service|system|everything|anything|it)\s+(up|down|healthy|working|operational|broken|online|offline)\b|^\s*is\s+\S+(\s+\S+)?\s+(up|down|online|offline)\s*\??\s*$|\bany(thing)?\s+(down|broken|outages?)\b/.test(q)) return 'overall';
  return null;
}

const host = (u) => { try { return new URL(u).host; } catch { return u; } };
const NAMES = { up: 'healthy', degraded: 'degraded', down: 'down', unknown: 'unverified' };

function websiteLine(h) {
  const w = h.website;
  if (w.state === 'not_configured') return 'No website URL is configured for this project, so I could not check the site.';
  if (w.state === 'up') return `The website (${host(w.url)}) is online; it loaded in ${(w.latencyMs / 1000).toFixed(1)} s.`;
  return `The website (${host(w.url)}) is not reachable right now (${w.error}).`;
}

function backendLine(h) {
  const b = h.backend;
  if (b.state === 'up') return 'The backend API is running and its health check passes.';
  if (b.state === 'degraded') return 'The backend API is running but reports itself as degraded.';
  if (b.state === 'down' && b.endpoints.length) return 'The backend API is responding but reports itself as unhealthy.';
  if (b.state === 'down') return `The backend API is not responding (${b.error}). It may be down or still starting up.`;
  const html = b.rejected.some((r) => /HTML/.test(r.reason));
  return `I couldn't verify the backend: none of its health endpoints returned a structured health report${html ? ' (they served the website\'s HTML page instead)' : ''}.`;
}

function databaseLine(h) {
  const d = h.database;
  const engine = h.primaryDatabase ? ` (${h.primaryDatabase.replace(/\s*\(.*\)\s*$/, '')})` : '';
  if (d.state === 'up') return `The database${engine} is connected.`;
  if (d.state === 'degraded' && d.fallbackType) {
    const lead = d.primary === 'disconnected' ? `The primary database${engine} is not connected` : `The backend is not using its primary database${engine}`;
    return `${lead}: the backend is serving data from its fallback storage ("${d.fallbackType}"). The site still works, but this storage is meant for development and changes may not survive a server restart or redeploy.`;
  }
  if (d.state === 'degraded') return 'The database reports a degraded state.';
  if (d.state === 'down') return `The database${engine} is not connected, according to the backend's health check.`;
  if (h.backend.state === 'down') return 'The database could not be checked because the backend is not responding.';
  return "The backend's health check doesn't report database status, so I can't confirm the database connection.";
}

function integrationsLine(h) {
  const { state, items } = h.integrations;
  if (state === 'none') return 'No external integrations are connected to this assistant, and the application\'s health check does not report any.';
  const down = items.filter((x) => x.state !== 'up');
  if (!down.length) return `All ${items.length} connected integration${items.length > 1 ? 's are' : ' is'} working (${items.map((x) => x.name).join(', ')}).`;
  return `${down.length} of ${items.length} integration${items.length > 1 ? 's are' : ' is'} unavailable: ${down.map((x) => `${x.name}${x.error ? ` (${x.error})` : ''}`).join('; ')}.`;
}

export function describeHealth(h, focus = 'overall', projectName = 'The application') {
  const time = new Date(h.checkedAt).toISOString().slice(11, 16);
  const checked = ` (checked just now, ${time} UTC)`;
  if (focus === 'website') return websiteLine(h) + checked;
  if (focus === 'backend') return `${backendLine(h)}${h.backend.state === 'up' && h.database.state !== 'up' && h.database.state !== 'unknown' ? ` However, ${databaseLine(h).charAt(0).toLowerCase()}${databaseLine(h).slice(1)}` : ''}${checked}`;
  if (focus === 'database') return databaseLine(h) + checked;
  if (focus === 'integrations') return integrationsLine(h) + checked;
  const lead = {
    healthy: `${projectName} is healthy: the website, backend and database all check out.`,
    degraded: `${projectName} is up, but not fully healthy.`,
    partial_outage: `${projectName} has a partial outage.`,
    down: `${projectName} appears to be down: neither the website nor the backend responded.`,
    unverified: `${projectName}'s website is up, but I could only partly verify the rest.`,
  }[h.overall];
  const lines = [websiteLine(h), backendLine(h)];
  if (h.backend.state !== 'down' || h.database.state !== 'unknown') lines.push(databaseLine(h));
  if (h.integrations.state !== 'none') lines.push(integrationsLine(h));
  return `${lead}${checked}\n\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

export const healthStateName = (s) => NAMES[s] || s;
