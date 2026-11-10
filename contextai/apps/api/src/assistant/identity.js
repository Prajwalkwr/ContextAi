// What the project is, who uses it and what it offers, in the words a visitor expects. The owner's
// configured identity wins; otherwise it is derived from the indexed documentation and code
// (an "About"/"What X is" section, a role enum in the data models, the topics of the help docs).
import { db } from '../lib/db.js';

const cache = new Map();

const clean = (s) => s.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();

function sections(chunks) {
  const out = [];
  for (const c of chunks) {
    let heading = null;
    let level = 0;
    let body = [];
    const flush = () => { if (heading && body.join(' ').trim()) out.push({ source: c.source, heading, level, text: clean(body.join(' ')) }); body = []; };
    for (const line of String(c.content || '').split('\n')) {
      const h = line.match(/^(#{1,3})\s+(.+?)\s*#*$/);
      if (h) { flush(); heading = clean(h[2]); level = h[1].length; continue; }
      if (/^\s*(```|\|)/.test(line)) continue;
      body.push(line);
    }
    flush();
  }
  return out;
}

const firstParagraph = (text) => text.split(/(?<=[.!?])\s+(?=[A-Z])/).slice(0, 3).join(' ').slice(0, 600);

function rolesFromCode(chunks) {
  for (const c of chunks) {
    const m = String(c.content || '').match(/\broles?\s*:\s*\{[^}]*?\benum\s*:\s*\[([^\]]+)\]/);
    if (!m) continue;
    const roles = [...m[1].matchAll(/['"]([a-z][a-z _-]{1,20})['"]/gi)].map((x) => x[1].toLowerCase());
    if (roles.length >= 2 && roles.length <= 8) return roles;
  }
  return [];
}

export function deriveIdentity(project) {
  const key = `${project.id}:${project.lastIndexedAt || ''}`;
  if (cache.has(key)) return cache.get(key);
  const chunks = db.getChunks(project.id);
  const docs = chunks.filter((c) => c.type === 'doc');
  const secs = sections(docs);
  const name = project.name.toLowerCase();
  const about = secs.find((s) => /^(what\s+.+\s+is|about(\s+.+)?|overview|introduction)$/i.test(s.heading) && s.text.length > 60 && !/^(quick|install|setup|getting started)/i.test(s.text))
    || secs.find((s) => s.level === 1 && s.text.toLowerCase().includes(name) && s.text.length > 80 && !/\b(npm|install|prerequisites|docker)\b/i.test(s.text.slice(0, 200)));
  const rolesSection = secs.find((s) => /\b(account types?|user types?|roles?|who can use|who is it for)\b/i.test(s.heading));
  const roles = rolesFromCode(chunks.filter((c) => c.type !== 'doc'));
  const topics = [...new Set(secs.filter((s) => s.level === 1 && !/readme|production|changelog|license|contributing/i.test(s.source)).map((s) => s.heading.replace(/^(about|selling on)\s+/i, (m) => (/selling/i.test(m) ? 'Selling on ' : '')).trim()))]
    .filter((t) => t && t.toLowerCase() !== name && !/^(help|faq)/i.test(t)).slice(0, 10);
  const identity = {
    summary: about ? firstParagraph(about.text) : null,
    rolesText: rolesSection ? firstParagraph(rolesSection.text) : null,
    roles: roles.map((r) => ({ name: r })),
    features: [],
    topics,
    derived: true,
  };
  cache.set(key, identity);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return identity;
}

export function identityOf(project, settings) {
  const owner = settings.identity || {};
  const derived = deriveIdentity(project);
  return {
    summary: owner.summary || derived.summary || project.description || null,
    audience: owner.audience || null,
    roles: owner.roles?.length ? owner.roles : derived.roles,
    rolesText: owner.roles?.length ? null : derived.rolesText,
    features: owner.features?.length ? owner.features : derived.features,
    topics: derived.topics,
    configured: !!(owner.summary || owner.roles?.length || owner.features?.length),
  };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (r) => (/(s|sh|ch)$/.test(r) ? `${r}es` : `${r}s`);
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export function describeRoles(identity, name) {
  if (identity.roles.length && identity.roles.some((r) => r.description)) {
    return `${name} has ${identity.roles.length} kinds of accounts:\n\n${identity.roles.map((r) => `- **${cap(plural(r.name))}**${r.description ? ` ${r.description}` : ''}`).join('\n')}${identity.audience ? `\n\n${identity.audience}` : ''}`;
  }
  if (identity.rolesText) return identity.rolesText;
  if (identity.roles.length) return `${name} supports ${identity.roles.length} kinds of accounts: ${list(identity.roles.map((r) => plural(r.name)))}.`;
  return null;
}

export function describeFeatures(identity, name) {
  if (identity.features.length) return `${name}'s main features:\n\n${identity.features.map((f) => `- ${f}`).join('\n')}`;
  if (identity.topics.length) return `${identity.summary ? `${identity.summary}\n\n` : ''}Its main areas are ${list(identity.topics.map((t) => t.toLowerCase()))}.`;
  return null;
}

export function describeOverview(identity, name, { brief = false } = {}) {
  if (!identity.summary) return null;
  const summary = /^[A-Z]/.test(identity.summary) && identity.summary.toLowerCase().includes(name.toLowerCase()) ? identity.summary : `${name}: ${identity.summary}`;
  if (brief) return summary;
  const parts = [summary];
  if (identity.roles.length) parts.push(`It is used by ${list(identity.roles.map((r) => plural(r.name)))}.`);
  if (identity.features.length) parts.push(`Highlights include ${list(identity.features.slice(0, 4).map((f) => f.charAt(0).toLowerCase() + f.slice(1).replace(/\.$/, '')))}.`);
  return parts.join(' ');
}
