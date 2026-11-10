// BM25 keyword retrieval over a single project's chunks, with code-aware tokenisation
// (camelCase / snake_case split) and path boosting. Scoped per project by construction.
import { db } from '../lib/db.js';

const STOP = new Set('the a an and or of to in on for is are was were be how does do what which why where when who this that with from by it its as at can i my me we our you your there their them about into than then so if not no yes'.split(' '));

export function tokenize(text) {
  return String(text || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

const undouble = (t) => (/([b-df-hj-np-tv-z])\1$/.test(t) && !/(ss|ll)$/.test(t.slice(-2)) ? t.slice(0, -1) : t.replace(/ll$/, 'l'));

export function stem(word) {
  let t = word;
  if (t.length > 4 && t.endsWith('ies')) t = t.slice(0, -3) + 'y';
  else if (t.length > 4 && /(ss|sh|ch|x)es$/.test(t)) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t)) t = t.slice(0, -1);
  if (t.length > 7 && t.endsWith('ation')) t = undouble(t.slice(0, -5));
  else if (t.length > 5 && t.endsWith('ing')) t = undouble(t.slice(0, -3));
  else if (t.length > 4 && t.endsWith('ed')) t = undouble(t.slice(0, -2));
  else if (t.length > 6 && t.endsWith('ure')) t = t.slice(0, -3);
  return t;
}

export function searchKnowledge({ projectId, query, type, limit = 8 }) {
  let chunks = db.getChunks(projectId);
  if (type) chunks = chunks.filter((c) => c.type === type);
  const qTokens = [...new Set(tokenize(query))];
  if (!chunks.length || !qTokens.length) return [];

  const docs = chunks.map((c) => {
    const tokens = tokenize(c.content);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return { chunk: c, tf, len: tokens.length, pathTokens: new Set(tokenize(c.source)) };
  });
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1;
  const df = new Map(qTokens.map((t) => [t, docs.filter((d) => d.tf.has(t) || d.pathTokens.has(t)).length]));
  const k1 = 1.2;
  const b = 0.75;

  const scored = docs.map((d) => {
    let score = 0;
    let matched = 0;
    for (const t of qTokens) {
      const n = df.get(t);
      if (!n) continue;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      const f = d.tf.get(t) || 0;
      if (f || d.pathTokens.has(t)) matched++;
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgLen)));
      if (d.pathTokens.has(t)) score += idf * 1.5;
    }
    score *= 0.5 + matched / qTokens.length;
    return { chunk: d.chunk, score, matched };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);

  const perSource = new Map();
  const results = [];
  for (const s of scored) {
    const n = perSource.get(s.chunk.source) || 0;
    if (n >= 2) continue;
    perSource.set(s.chunk.source, n + 1);
    results.push({
      source: s.chunk.source,
      url: s.chunk.url || null,
      sourceVersion: s.chunk.sourceVersion || null,
      type: s.chunk.type,
      lines: s.chunk.startLine ? `${s.chunk.startLine}-${s.chunk.endLine}` : null,
      score: Number(s.score.toFixed(3)),
      snippet: s.chunk.content.slice(0, 700),
    });
    if (results.length >= limit) break;
  }
  return results;
}
