// Provider abstraction over the official OpenAI SDK. Every call is optional: without
// OPENAI_API_KEY the engine still answers project data/code questions deterministically.
// Timeouts and retries (429/5xx/connection errors, exponential backoff) are handled by the SDK.
import OpenAI from 'openai';
import { createHash } from 'crypto';
import { metrics } from './metrics.js';

let client = null;
let injected = null;
const inflight = new Map();

const num = (v, d) => (Number(v) > 0 ? Number(v) : d);

// Any OpenAI-compatible provider works through LLM_BASE_URL: a local Ollama server
// (http://localhost:11434/v1, no key needed), Groq, OpenRouter, Gemini's OpenAI endpoint…
const baseURL = () => process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || undefined;
const isOpenAI = () => !baseURL() || /api\.openai\.com/.test(baseURL());

function getClient() {
  if (injected) return injected;
  client ||= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || 'not-needed',
    baseURL: baseURL(),
    timeout: num(process.env.OPENAI_TIMEOUT_MS, isOpenAI() ? 30000 : 120000),
    maxRetries: num(process.env.OPENAI_MAX_RETRIES, isOpenAI() ? 2 : 0),
  });
  return client;
}

// Converts SDK errors into messages that are safe to show and never contain credentials.
function friendly(e) {
  const status = e?.status;
  const message = status === 401 ? 'OpenAI rejected the API key (check OPENAI_API_KEY)'
    : status === 429 ? 'OpenAI rate limit or quota reached; try again shortly'
    : status === 400 ? `OpenAI rejected the request: ${String(e.message || '').slice(0, 200)}`
    : e?.name === 'APIConnectionTimeoutError' ? 'OpenAI request timed out'
    : status ? `OpenAI error ${status}` : `OpenAI unavailable: ${String(e?.message || e).slice(0, 120)}`;
  return Object.assign(new Error(message), { status: status === 429 ? 429 : 502, upstreamStatus: status });
}

// Identical concurrent requests share one upstream call.
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function tracked(model, fn, webSearchesOf = () => 0) {
  try {
    const r = await fn();
    metrics.llm({ model, usage: r.usage, webSearches: webSearchesOf(r) });
    return r;
  } catch (e) {
    metrics.llmError();
    throw friendly(e);
  }
}

const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

function citationsFrom(resp) {
  const out = [];
  for (const item of resp.output || []) {
    if (item.type !== 'message') continue;
    for (const part of item.content || []) {
      for (const a of part.annotations || []) {
        if (a.type === 'url_citation' && a.url && !out.some((c) => c.url === a.url)) out.push({ url: a.url, title: a.title || a.url });
      }
    }
  }
  return out;
}

const textOf = (resp) => resp.output_text
  ?? (resp.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []).map((p) => p.text || '').join('');

export const llm = {
  isEnabled: () => !!injected || !!process.env.OPENAI_API_KEY || !!process.env.LLM_API_KEY || !!process.env.LLM_BASE_URL,
  // Hosted web search and embeddings exist only on OpenAI itself (or when explicitly configured).
  supportsWebSearch: () => !!injected || (isOpenAI() && !!process.env.OPENAI_API_KEY),
  supportsEmbeddings: () => !!injected || (isOpenAI() && !!process.env.OPENAI_API_KEY) || !!process.env.OPENAI_EMBEDDING_MODEL,
  provider: () => (injected ? 'test' : isOpenAI() ? 'openai' : baseURL()),

  // Model per task so cheap models can route while stronger ones answer.
  model(task = 'answer') {
    const base = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    if (task === 'router') return process.env.OPENAI_ROUTER_MODEL || base;
    if (task === 'search') return process.env.OPENAI_SEARCH_MODEL || base;
    if (task === 'embedding') return process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
    return base;
  },

  // Kept for the deterministic engine's rephrasing step.
  async generate({ system, user }) {
    if (!this.isEnabled()) return null;
    const model = this.model();
    const resp = await tracked(model, () => getClient().chat.completions.create({
      model, temperature: 0.1, max_tokens: 600,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }));
    return resp.choices[0].message;
  },

  // Chat completion, optionally constrained to a strict JSON schema (structured outputs).
  async chat({ task = 'answer', messages, schema, maxTokens = 900, temperature = 0.2 }) {
    if (!this.isEnabled()) return null;
    const model = this.model(task);
    const params = {
      model, temperature, max_tokens: maxTokens, messages,
      ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } } } : {}),
    };
    const resp = await once(hash(params), () => tracked(model, () => getClient().chat.completions.create(params)));
    const msg = resp.choices?.[0]?.message || {};
    if (msg.refusal) return { text: '', json: null, refusal: msg.refusal };
    let json = null;
    if (schema) {
      try { json = JSON.parse(msg.content || ''); } catch { throw friendly(new Error('model returned invalid JSON for a structured response')); }
    }
    return { text: msg.content || '', json };
  },

  // Web research through the Responses API's hosted web search tool. Returns the answer text and
  // the url_citation annotations the model attached; nothing else is ever presented as a source.
  async webSearch({ instructions, input, allowedDomains = [] }) {
    if (!this.isEnabled()) return null;
    const model = this.model('search');
    const toolType = process.env.OPENAI_WEB_SEARCH_TOOL || 'web_search';
    const tool = { type: toolType, ...(allowedDomains.length && toolType === 'web_search' ? { filters: { allowed_domains: allowedDomains } } : {}) };
    const params = { model, instructions, input, tools: [tool], max_output_tokens: num(process.env.OPENAI_SEARCH_MAX_TOKENS, 1400) };
    const resp = await once(hash(params), () => tracked(model, () => getClient().responses.create(params),
      (r) => (r.output || []).filter((o) => o.type === 'web_search_call').length));
    return {
      text: textOf(resp).trim(),
      citations: citationsFrom(resp),
      searches: (resp.output || []).filter((o) => o.type === 'web_search_call').length,
      model,
    };
  },

  // One step of a tool-calling conversation; returns the assistant message (text and/or tool_calls).
  async chatWithTools({ task = 'answer', messages, tools, maxTokens = 1200, temperature = 0.2 }) {
    if (!this.isEnabled()) return null;
    const model = this.model(task);
    const params = { model, temperature, max_tokens: maxTokens, messages, ...(tools?.length ? { tools, tool_choice: 'auto' } : {}) };
    const resp = await tracked(model, () => getClient().chat.completions.create(params));
    return resp.choices?.[0]?.message || { content: '' };
  },

  async embed(texts) {
    if (!this.isEnabled() || !texts.length) return null;
    if (!isOpenAI() && !process.env.OPENAI_EMBEDDING_MODEL) return null;
    const model = this.model('embedding');
    const dimensions = num(process.env.OPENAI_EMBEDDING_DIMENSIONS, 512);
    const resp = await tracked(model, () => getClient().embeddings.create({ model, input: texts, dimensions }));
    return resp.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  },

  // Tests inject a stub implementing the same SDK surface; production never calls this.
  setClientForTesting(stub) { injected = stub; inflight.clear(); },
};
