// Hybrid retrieval over one project's indexed chunks: BM25 keyword ranking + optional embedding
// similarity, fused with reciprocal-rank fusion, filtered by metadata, de-duplicated, reranked and
// finally gated by a relevance check. A chunk is never "relevant" merely because it was retrieved.
import { createHash } from 'crypto';
import { db } from '../lib/db.js';
import { tokenize } from '../knowledge/search.js';
import { chunkHash, semanticScores } from './embeddings.js';

// Words that say how a question is asked rather than what it is about.
const GENERIC = new Set(tokenize('many much work works working use used using tell explain describe show list get give know need want like please thing things way does have has had make made also just any some all more most other same such only very well can could would should will may might must one new good best kind type types info information detail details about help happen happens mean means workflow process flow step steps internally exactly ask asks asked regarding method methods option options available'));

export const retrievalConfig = () => ({
  // Share of the question's IDF-weighted content terms a chunk must contain. Calibrated with
  // apps/api/scripts/eval-retrieval.js against labelled project/general questions.
  minCoverage: Number(process.env.RETRIEVAL_MIN_COVERAGE) || 0.6,
  // Cosine similarity a chunk needs when the semantic index is used. Recalibrate per embedding model.
  minSimilarity: Number(process.env.RETRIEVAL_MIN_SIMILARITY) || 0.45,
  candidates: 30,
});

const corpora = new Map();

function corpus(projectId) {
  const chunks = db.getChunks(projectId);
  const version = `${chunks.length}:${chunks[0]?.id}:${chunks.at(-1)?.id}`;
  const cached = corpora.get(projectId);
  if (cached?.version === version) return cached;
  const docs = chunks.map((c) => {
    const tokens = tokenize(c.content);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return { chunk: c, tf, len: tokens.length, pathTokens: new Set(tokenize(c.source)), hash: chunkHash(c) };
  });
  const df = new Map();
  // What the project is about: words of its documentation and pages, and its file names. Words that
  // only occur inside source code (CSS colours, library calls) don't say what the project covers.
  const vocabulary = new Set();
  for (const d of docs) {
    for (const t of new Set([...d.tf.keys(), ...d.pathTokens])) df.set(t, (df.get(t) || 0) + 1);
    for (const t of d.pathTokens) vocabulary.add(t);
    if (d.chunk.type !== 'code') for (const t of d.tf.keys()) vocabulary.add(t);
  }
  const built = { version, docs, df, vocabulary, N: docs.length, avgLen: docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1) };
  corpora.set(projectId, built);
  return built;
}

const idfOf = (c, t) => Math.log(1 + (c.N - (c.df.get(t) || 0) + 0.5) / ((c.df.get(t) || 0) + 0.5));

// `scope` holds tokens that only say which project is meant (its name); a chunk need not repeat
// the project name to be about it.
export function contentTokens(text, scope = []) {
  const all = [...new Set(tokenize(text))];
  const content = all.filter((t) => !GENERIC.has(t) && !scope.includes(t));
  return content.length ? content : all;
}

// The question's own subject words, without falling back to generic ones ("How does it work?" → []).
export const topicTokens = (text, scope = []) => [...new Set(tokenize(text))].filter((t) => !GENERIC.has(t) && !scope.includes(t));

// How much of the question's meaning (IDF-weighted) a chunk actually contains. Terms that never
// occur in the project carry the most weight, so off-topic questions score near zero.
function coverage(c, doc, terms) {
  let have = 0, total = 0;
  for (const t of terms) {
    const w = idfOf(c, t);
    total += w;
    if (doc.tf.has(t) || doc.pathTokens.has(t)) have += w;
  }
  return total ? have / total : 0;
}

// Project-level signal: share of question meaning that exists anywhere in the project's corpus.
export function corpusCoverage(projectId, text, scopeTerms = []) {
  const c = corpus(projectId);
  const terms = contentTokens(text, scopeTerms);
  if (!c.N || !terms.length) return { coverage: 0, prose: 0, missing: terms, empty: !c.N };
  let have = 0, inProse = 0, total = 0;
  const missing = [];
  for (const t of terms) {
    const w = idfOf(c, t);
    total += w;
    if (c.df.has(t)) have += w; else missing.push(t);
    if (c.vocabulary.has(t)) inProse += w;
  }
  // prose: the same share counting only the project's vocabulary (see corpus()).
  return { coverage: total ? have / total : 0, prose: total ? inProse / total : 0, missing };
}

const norm = (s) => createHash('sha1').update(s.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');

export async function hybridSearch({ projectId, query, limit = 8, types, technical = false, semantic = true, scopeTerms = [] }) {
  const cfg = retrievalConfig();
  const c = corpus(projectId);
  const terms = contentTokens(query, scopeTerms);
  const empty = { results: [], kept: [], discarded: [], stats: { mode: 'none', candidates: 0, topCoverage: 0, topSimilarity: null } };
  if (!c.N || !terms.length) return empty;

  const pool = types?.length ? c.docs.filter((d) => types.includes(d.chunk.type)) : c.docs;
  const k1 = 1.2, b = 0.75;
  const bm25 = pool.map((d) => {
    let score = 0;
    for (const t of terms) {
      const f = d.tf.get(t) || 0;
      if (!f && !d.pathTokens.has(t)) continue;
      const idf = idfOf(c, t);
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / c.avgLen)));
      if (d.pathTokens.has(t)) score += idf * 1.5;
    }
    return { d, score };
  }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score).slice(0, cfg.candidates);

  let sims = null;
  if (semantic) {
    try { sims = await semanticScores(projectId, query); } catch { sims = null; }
  }
  const semRank = sims ? pool.map((d) => ({ d, sim: sims.get(d.hash) ?? 0 })).sort((x, y) => y.sim - x.sim).slice(0, cfg.candidates) : [];

  const fused = new Map();
  const add = (d, rank) => {
    const e = fused.get(d.hash) || { d, rrf: 0 };
    e.rrf += 1 / (60 + rank);
    fused.set(d.hash, e);
  };
  bm25.forEach((x, i) => add(x.d, i));
  semRank.forEach((x, i) => add(x.d, i));

  const seen = new Set();
  const ranked = [];
  for (const e of [...fused.values()]) {
    const cov = coverage(c, e.d, terms);
    const sim = sims ? sims.get(e.d.hash) ?? 0 : null;
    // Prose explains features; code explains implementation. Prefer the one the question needs.
    const prior = technical ? (e.d.chunk.type === 'code' ? 1.1 : 1) : (e.d.chunk.type === 'code' ? 0.8 : 1.1);
    const relevant = cov >= cfg.minCoverage || (sim !== null && sim >= cfg.minSimilarity);
    ranked.push({ e, cov, sim, relevant, score: e.rrf * prior * (0.5 + cov) * (sim !== null ? 0.5 + Math.max(sim, 0) : 1) });
  }
  ranked.sort((x, y) => y.score - x.score);

  const results = [];
  for (const r of ranked) {
    const ch = r.e.d.chunk;
    const key = norm(ch.content);
    if (seen.has(key)) continue;
    seen.add(key);
    const overlapping = results.find((x) => x.source === ch.source && x.startLine && ch.startLine && ch.startLine <= x.endLine && ch.endLine >= x.startLine);
    if (overlapping) continue;
    results.push({
      source: ch.source, url: ch.url || null, sourceVersion: ch.sourceVersion || null,
      type: ch.type, startLine: ch.startLine, endLine: ch.endLine,
      lines: ch.startLine ? `${ch.startLine}-${ch.endLine}` : null,
      snippet: ch.content.slice(0, 900),
      score: Number(r.score.toFixed(5)), coverage: Number(r.cov.toFixed(3)), similarity: r.sim === null ? null : Number(r.sim.toFixed(3)),
      relevant: r.relevant,
    });
    if (results.length >= limit * 2) break;
  }
  const kept = results.filter((r) => r.relevant).slice(0, limit);
  return {
    results,
    kept,
    discarded: results.filter((r) => !r.relevant),
    stats: {
      mode: sims ? 'hybrid' : 'keyword',
      candidates: fused.size,
      topCoverage: results.length ? Math.max(...results.map((r) => r.coverage)) : 0,
      topSimilarity: sims && results.length ? Math.max(...results.map((r) => r.similarity ?? 0)) : null,
      thresholds: { minCoverage: cfg.minCoverage, minSimilarity: sims ? cfg.minSimilarity : null },
    },
  };
}
