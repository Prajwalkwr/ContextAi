// Developer-registered HTTP tools. GET tools are read-only and may run directly.
// Any other method changes application data and only runs through an approved action request.
// Writes always go through the application's own API, so its validation and permissions still apply.
import { db } from '../lib/db.js';
import { decrypt } from '../lib/crypto.js';
import { assertPublicUrl, fetchWithTimeout } from '../lib/netguard.js';

const PARAM = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
export const isWrite = (tool) => (tool.method || 'GET') !== 'GET';

export function validateParams(tool, params = {}) {
  const declared = tool.parameters || [];
  for (const [k, v] of Object.entries(params)) {
    if (!PARAM.test(k) || !declared.includes(k)) throw Object.assign(new Error(`Parameter "${k}" is not declared for this tool`), { status: 400 });
    if (!['string', 'number', 'boolean'].includes(typeof v)) throw Object.assign(new Error(`Parameter "${k}" must be a primitive`), { status: 400 });
  }
  const missing = (tool.requiredParameters || []).filter((p) => params[p] === undefined || params[p] === '');
  if (missing.length) throw Object.assign(new Error(`Missing required parameter(s): ${missing.join(', ')}`), { status: 400 });
  return params;
}

function buildRequest(tool, params) {
  const rest = { ...params };
  const path = tool.url.replace(/\{(\w+)\}/g, (_, k) => {
    if (rest[k] === undefined) throw Object.assign(new Error(`Missing path parameter "${k}"`), { status: 400 });
    const v = encodeURIComponent(String(rest[k]));
    delete rest[k];
    return v;
  });
  const url = assertPublicUrl(path);
  const write = isWrite(tool);
  if (!write) for (const [k, v] of Object.entries(rest)) url.searchParams.set(k, String(v));
  return { url, body: write && Object.keys(rest).length ? JSON.stringify(rest) : undefined };
}

export async function executeTool({ projectId, tool, params = {}, actor, approvedActionId }) {
  if (tool.projectId !== projectId) throw Object.assign(new Error('Tool does not belong to project'), { status: 403 });
  if (isWrite(tool) && !approvedActionId) throw Object.assign(new Error(`"${tool.name}" changes data and requires an approved action request`), { status: 403 });
  validateParams(tool, params);
  const { url, body } = buildRequest(tool, params);
  const headers = { ...(tool.encryptedHeaders ? decrypt(tool.encryptedHeaders) : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
  if (approvedActionId) headers['Idempotency-Key'] = approvedActionId;
  try {
    const res = await fetchWithTimeout(url, { method: tool.method || 'GET', headers, body }, 10000);
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 5000); }
    db.addAudit({ projectId, actor, action: isWrite(tool) ? 'action.execute' : 'tool.execute', target: tool.name, status: res.ok ? 'success' : 'error', httpStatus: res.status, actionId: approvedActionId });
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (e) {
    db.addAudit({ projectId, actor, action: isWrite(tool) ? 'action.execute' : 'tool.execute', target: tool.name, status: 'error', error: e.message, actionId: approvedActionId });
    throw Object.assign(new Error(`Tool "${tool.name}" failed: ${e.message}`), { status: 502 });
  }
}
