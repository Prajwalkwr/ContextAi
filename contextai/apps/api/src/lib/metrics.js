// In-process measurements of the assistant: latency, routes, tokens, web searches, retrieval
// gating and failures. Per-request usage is attributed through AsyncLocalStorage so the LLM
// layer does not need to know which project or request it is serving.
import { AsyncLocalStorage } from 'async_hooks';

const store = new AsyncLocalStorage();
const projects = new Map();

const blank = () => ({
  requests: 0, failures: 0, totalMs: 0, cacheHits: 0,
  routes: {}, llmCalls: 0, llmErrors: 0, inputTokens: 0, outputTokens: 0, webSearches: 0,
  retrieval: { queries: 0, kept: 0, discarded: 0 }, refused: 0,
  googleSearch: { requests: 0, queries: 0, grounded: 0, ungrounded: 0, fallbacks: 0, failures: 0, timeouts: 0, quotaRejections: 0 },
});

const forProject = (id) => {
  if (!projects.has(id)) projects.set(id, blank());
  return projects.get(id);
};

export const metrics = {
  // Runs fn with a fresh usage accumulator and records latency/outcome for the project.
  async track(projectId, fn) {
    const usage = { llmCalls: 0, inputTokens: 0, outputTokens: 0, webSearches: 0, models: [] };
    const started = Date.now();
    const m = forProject(projectId);
    m.requests++;
    try {
      return await store.run({ projectId, usage }, () => fn(usage));
    } catch (e) {
      m.failures++;
      throw e;
    } finally {
      m.totalMs += Date.now() - started;
    }
  },

  llm({ model, usage, webSearches = 0 }) {
    const ctx = store.getStore();
    const input = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
    const output = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
    if (ctx) {
      Object.assign(ctx.usage, {
        llmCalls: ctx.usage.llmCalls + 1,
        inputTokens: ctx.usage.inputTokens + input,
        outputTokens: ctx.usage.outputTokens + output,
        webSearches: ctx.usage.webSearches + webSearches,
      });
      if (!ctx.usage.models.includes(model)) ctx.usage.models.push(model);
      const m = forProject(ctx.projectId);
      m.llmCalls++;
      m.inputTokens += input;
      m.outputTokens += output;
      m.webSearches += webSearches;
    }
  },

  llmError() {
    const ctx = store.getStore();
    if (ctx) forProject(ctx.projectId).llmErrors++;
  },

  // One Google Search grounding request (successful, failed or refused before it was sent).
  search({ queries = 0, grounded = false, fallback = false, failed = false, timeout = false, quotaRejected = false }) {
    const ctx = store.getStore();
    if (!ctx) return;
    const g = forProject(ctx.projectId).googleSearch;
    if (quotaRejected) { g.quotaRejections++; return; }
    g.requests++;
    if (failed) { g.failures++; if (timeout) g.timeouts++; return; }
    g.queries += queries;
    if (grounded) g.grounded++; else g.ungrounded++;
    if (fallback) g.fallbacks++;
  },

  route(projectId, intents) {
    const m = forProject(projectId);
    for (const i of intents) m.routes[i] = (m.routes[i] || 0) + 1;
  },

  retrieval(projectId, kept, discarded) {
    const r = forProject(projectId).retrieval;
    r.queries++;
    r.kept += kept;
    r.discarded += discarded;
  },

  cacheHit(projectId) { forProject(projectId).cacheHits++; },
  refused(projectId) { forProject(projectId).refused++; },

  snapshot(projectId) {
    const m = forProject(projectId);
    return {
      ...m,
      averageResponseMs: m.requests ? Math.round(m.totalMs / m.requests) : null,
      averageTokensPerRequest: m.requests ? Math.round((m.inputTokens + m.outputTokens) / m.requests) : null,
      retrievalDiscardRate: m.retrieval.kept + m.retrieval.discarded ? Number((m.retrieval.discarded / (m.retrieval.kept + m.retrieval.discarded)).toFixed(3)) : null,
    };
  },

  reset() { projects.clear(); },
};
