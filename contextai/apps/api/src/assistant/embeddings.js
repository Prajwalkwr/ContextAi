// Semantic index for a project's chunks. Built in the background after indexing (and lazily on
// first use), keyed by content hash so re-indexing only embeds chunks that actually changed.
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { db } from '../lib/db.js';
import { llm } from '../lib/llm.js';

const loaded = new Map();
const building = new Map();
const BATCH = 96;

export const chunkHash = (c) => createHash('sha1').update(`${c.source}\n${c.content}`).digest('hex');
export const embeddingsEnabled = () => llm.isEnabled() && llm.supportsEmbeddings() && process.env.EMBEDDINGS_ENABLED !== 'false';

function file(projectId) {
  const dir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'embeddings');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${projectId.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
}

function load(projectId) {
  const model = llm.model('embedding');
  const cached = loaded.get(projectId);
  if (cached && cached.model === model) return cached;
  let idx = { model, vectors: new Map() };
  try {
    const raw = JSON.parse(fs.readFileSync(file(projectId), 'utf-8'));
    if (raw.model === model) idx = { model, vectors: new Map(Object.entries(raw.vectors)) };
  } catch { /* no index yet */ }
  loaded.set(projectId, idx);
  return idx;
}

const round = (v) => v.map((x) => Math.round(x * 1e4) / 1e4);

export function buildEmbeddings(projectId) {
  if (!embeddingsEnabled()) return Promise.resolve({ embedded: 0 });
  if (building.has(projectId)) return building.get(projectId);
  const job = (async () => {
    const idx = load(projectId);
    const chunks = db.getChunks(projectId);
    const live = new Set(chunks.map(chunkHash));
    const missing = chunks.filter((c) => !idx.vectors.has(chunkHash(c)));
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const vectors = await llm.embed(batch.map((c) => `${c.source}\n${c.content}`.slice(0, 6000)));
      batch.forEach((c, j) => idx.vectors.set(chunkHash(c), round(vectors[j])));
    }
    for (const h of idx.vectors.keys()) if (!live.has(h)) idx.vectors.delete(h);
    fs.writeFileSync(file(projectId), JSON.stringify({ model: idx.model, vectors: Object.fromEntries(idx.vectors) }));
    return { embedded: missing.length };
  })().finally(() => building.delete(projectId));
  building.set(projectId, job);
  return job;
}

export function scheduleEmbeddings(projectId) {
  if (!embeddingsEnabled()) return;
  setImmediate(() => buildEmbeddings(projectId).catch((e) => console.warn(`[embeddings] ${projectId}: ${e.message}`)));
}

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

// Returns Map(chunkHash -> cosine similarity), or null when no semantic index is available yet.
export async function semanticScores(projectId, query) {
  if (!embeddingsEnabled()) return null;
  const idx = load(projectId);
  if (!idx.vectors.size) { scheduleEmbeddings(projectId); return null; }
  const [q] = await llm.embed([query]);
  const out = new Map();
  for (const [h, v] of idx.vectors) out.set(h, cosine(q, v));
  return out;
}

export function forgetEmbeddings(projectId) { loaded.delete(projectId); }
