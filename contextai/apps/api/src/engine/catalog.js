// Builds a project's data catalog from discovered schemas and maps question terms onto it.
// Relevance comes only from the project's own collection/field names and developer definitions.
import { tokenize } from '../knowledge/search.js';
import { refreshSchema } from '../connectors/index.js';

const ID_LIKE = /^_?id$|Id$|_id$|uuid|^email$|password|token|secret|hash/i;
const LABEL_LIKE = /^(name|title|label|displayName|display_name|fullName|full_name|businessName|productName|itemName|slug|summary|subject)$/i;
const isTimeName = (name) => /^(created|date|day|datetime|timestamp|time|start)$/i.test(name) || /(At|_at|Date|_date|Time|_time|On|_on|Timestamp)$/.test(name);
const OUTCOME_LIKE = /^(status|state|result|outcome|stage)$/i;
const EXPLAIN_LIKE = /reason|error|code|cause|message|failure|decline|note/i;

export const fieldTokens = (name) => new Set(tokenize(name));
export const overlap = (a, b) => [...a].filter((t) => b.has(t)).length;
// Stems differ across word forms ("registr" vs "register"), so a long shared prefix also counts.
export function nearToken(x, y) {
  if (x === y) return true;
  let p = 0;
  while (p < x.length && x[p] === y[p]) p++;
  return p >= 5 && p >= Math.min(x.length, y.length) - 2;
}
export const nearOverlap = (a, b) => [...a].some((x) => [...b].some((y) => nearToken(x, y)));

export async function buildCatalog(integrations) {
  const entries = [];
  const failures = [];
  for (const integration of integrations) {
    if (integration.status !== 'connected') {
      failures.push({ integration: integration.name, error: integration.health?.error || `status ${integration.status}` });
      continue;
    }
    try {
      const schema = integration.schema || await refreshSchema(integration);
      for (const [collection, info] of Object.entries(schema)) {
        if (integration.allowedCollections?.length && !integration.allowedCollections.includes(collection)) continue;
        entries.push({ integration, collection, count: info.count, fields: info.fields });
      }
    } catch (e) {
      failures.push({ integration: integration.name, error: e.message });
    }
  }
  return { entries, failures };
}

export function matchDefinitions(definitions, qTokens) {
  return definitions.filter((d) => {
    const terms = tokenize(d.term);
    return terms.length && terms.every((t) => qTokens.has(t));
  });
}

export const entryKey = (e) => `${e.integration.id}:${e.collection}`;

// Question tokens that name no collection or field, e.g. "show" in "no-show rate". These may refer
// to stored values (status = "no_show"), which only a distinct-value probe can reveal.
const GENERIC = new Set(tokenize('rate highest lowest most least top count number total average mean sum share percent percentage many much list give per each every'));
export function unmatchedTokens(entries, qTokens) {
  const names = new Set(entries.flatMap((e) => [...fieldTokens(e.collection), ...e.fields.flatMap((f) => [...fieldTokens(f.name)])]));
  return new Set([...qTokens].filter((t) => !names.has(t) && !GENERIC.has(t)));
}

export function rankCollections(entries, qTokens, definitions, valueHits = new Map()) {
  return entries.map((e) => {
    let score = 4 * overlap(fieldTokens(e.collection), qTokens);
    const matched = e.fields.map((f) => ({ name: f.name, hits: overlap(fieldTokens(f.name), qTokens) })).filter((f) => f.hits);
    const matchedFields = matched.map((f) => f.name);
    score += 1.5 * matched.reduce((s, f) => s + f.hits, 0);
    const values = valueHits.get(entryKey(e));
    if (values) { score += 4 * values.count; matchedFields.push(...values.fields.map((f) => `${f} (value)`)); }
    if (definitions.some((d) => d.collection === e.collection)) score += 6;
    return { ...e, score, matchedFields };
  }).filter((e) => e.score > 0).sort((a, b) => b.score - a.score);
}

export function describeFields(entry) {
  const fields = entry.fields.filter((f) => !ID_LIKE.test(f.name) || LABEL_LIKE.test(f.name));
  return {
    numeric: fields.filter((f) => f.type === 'number').map((f) => f.name),
    categorical: fields.filter((f) => ['string', 'boolean'].includes(f.type) && !LABEL_LIKE.test(f.name) && !isTimeName(f.name)).map((f) => f.name),
    label: entry.fields.find((f) => LABEL_LIKE.test(f.name))?.name || entry.fields.find((f) => /^_?id$/.test(f.name))?.name || null,
    time: (entry.fields.find((f) => isTimeName(f.name) && ['date', 'string'].includes(f.type)) || entry.fields.find((f) => f.type === 'date'))?.name || null,
    outcome: entry.fields.find((f) => OUTCOME_LIKE.test(f.name))?.name || null,
    explanatory: fields.filter((f) => f.type === 'string' && EXPLAIN_LIKE.test(f.name)).map((f) => f.name),
  };
}
