/**
 * @contextai/sdk — client for the ContextAI intelligence engine.
 *
 * Browser code must use the project's public key (pk_…), which only allows ask/search.
 * Server code may use the secret key (sk_…) for full project access. Never ship sk_ keys to a browser.
 */

export type ContextAIConfig = {
  projectId: string;
  baseUrl: string;
  publicKey?: string;
  secretKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type AskParams = {
  question: string;
  timeRange?: { from: string; to: string };
  /** Continue a conversation; returned by the previous ask(). */
  conversationId?: string;
  /** Stateless alternative to conversationId: up to 20 conversation turns, oldest first. */
  history?: { question: string; answer?: string }[];
  /**
   * End-user identity for "my orders"-style questions. Server code (secret key) may pass userId;
   * browser code (public key) must pass userToken, an HS256 JWT { sub: userId, aud: projectId }
   * signed by your backend with the project's user-token secret.
   */
  context?: { userId?: string; userToken?: string; [key: string]: unknown };
};

export type EvidenceKind = 'live_database' | 'uploaded_dataset' | 'synthetic_dataset' | 'indexed_code' | 'indexed_doc' | 'indexed_page' | 'business_definition' | 'project_profile' | 'registered_api' | 'web_page';

export type Intent = 'PROJECT_SPECIFIC' | 'GENERAL_KNOWLEDGE' | 'CURRENT_INFORMATION' | 'LIVE_APPLICATION_DATA' | 'ACTION_REQUEST' | 'MIXED_QUERY' | 'FOLLOW_UP' | 'UNKNOWN';
export type Source = 'project_knowledge' | 'live_data' | 'web_search' | 'model_knowledge';
type Level = 'high' | 'medium' | 'low';

export type ProposedAction = { toolId: string; tool: string; method: string; description: string; params: Record<string, string | number>; missing: string[]; requiresApproval: true };

export type InvestigationResult = {
  schemaVersion: '1.0';
  status: 'success' | 'insufficient_data' | 'clarification_needed';
  projectId: string;
  investigationId: string;
  question: string;
  intent: string;
  answer: string;
  findings: { text: string; basis: 'data' | 'code' | 'content' | 'api' | 'action'; evidence: string[] }[];
  proposedActions: ProposedAction[];
  evidence: ({ id: string; kind: EvidenceKind; source: string } & Record<string, unknown>)[];
  sources: { type: EvidenceKind; name: string }[];
  calculations: { label: string; formula: string; inputs: string; result: string; evidence?: string }[];
  limitations: string[];
  recommendedActions: string[];
  confidence: 'high' | 'medium' | 'low';
  confidenceBasis: string;
  timeRange: { from: string; to: string; label: string } | null;
  plan: { step: number; action: string; detail: string }[];
  answerMode: string;
  durationMs: number;
  investigatedAt: string;
};

/** Result of ask(): the assistant's routed, verified answer (a superset of InvestigationResult). */
export type AssistantResult = Omit<InvestigationResult, 'status' | 'sources'> & {
  status: InvestigationResult['status'] | 'refused' | 'unauthorized';
  conversationId: string;
  standaloneQuestion?: string;
  route: { intents: Intent[]; sources: Source[]; method: 'llm' | 'heuristic' | 'guard'; reason: string; personal?: boolean };
  sources: { type: EvidenceKind | 'model_knowledge'; name: string }[];
  /** `index` matches the [n] markers in a Google-grounded answer. */
  citations: { url: string; title: string; index?: number }[];
  /** Google Search Suggestions HTML. Display it unmodified with the answer (Gemini API terms), e.g. in a sandboxed iframe. */
  searchSuggestions?: string | null;
  webSearch?: { provider: 'google'; model: string; mode: 'required' | 'optional'; searched: boolean; grounded: boolean; queries: string[]; searches: number; fallbackFrom: string | null; durationMs: number };
  errorKind?: string;
  confidenceDetail: { retrievalRelevance: Level | 'none' | 'not_used'; sourceReliability: Level | 'none'; evidenceSufficiency: 'sufficient' | 'partial' | 'insufficient' | 'not_applicable'; answerConfidence: Level };
  retrieval: { mode: 'hybrid' | 'keyword' | 'none'; kept: number; discarded: { source: string; coverage: number; similarity: number | null }[] } | null;
  needsConfiguration?: string[];
  usage: { llmCalls: number; inputTokens: number; outputTokens: number; webSearches: number; models: string[] };
};

export type SearchResult = { source: string; type: string; lines: string | null; score: number; snippet: string };

export class ContextAIError extends Error {
  constructor(message: string, public status: number, public body?: unknown) {
    super(message);
    this.name = 'ContextAIError';
  }
}

export class ContextAI {
  private readonly projectId: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ContextAIConfig) {
    if (!config.projectId) throw new Error('projectId is required');
    if (!config.baseUrl) throw new Error('baseUrl is required (your ContextAI API URL)');
    if (!config.publicKey && !config.secretKey) throw new Error('publicKey or secretKey is required');
    if (config.publicKey?.startsWith('sk_')) throw new Error('A secret key was passed as publicKey. Use the pk_ key in browsers.');
    if (config.secretKey && typeof window !== 'undefined') throw new Error('secretKey must never be used in browser code');
    this.projectId = config.projectId;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = config.secretKey ? { 'X-Secret-Key': config.secretKey } : { 'X-Project-Key': config.publicKey! };
    this.timeoutMs = config.timeoutMs ?? 30000;
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/v1/projects/${encodeURIComponent(this.projectId)}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...this.headers, ...(init.headers as Record<string, string>) },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new ContextAIError((body as { error?: string }).error || `Request failed with ${res.status}`, res.status, body);
      return body as T;
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new ContextAIError(`Request timed out after ${this.timeoutMs}ms`, 408);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Asks the assistant. It decides which sources the question needs (project knowledge, live data,
   * web search, general knowledge), keeps conversation context and verifies the answer.
   */
  ask(params: AskParams): Promise<AssistantResult> {
    return this.request('/ask', { method: 'POST', body: JSON.stringify(params) });
  }

  /** The deterministic project engine only (data and code; no routing, web or general knowledge). */
  investigate(params: AskParams): Promise<InvestigationResult> {
    return this.request('/investigate', { method: 'POST', body: JSON.stringify(params) });
  }

  /** Structured summary of a topic, e.g. { topic: 'orders', timeRange }. */
  report(params: { topic?: string; question?: string; timeRange?: { from: string; to: string } }): Promise<InvestigationResult> {
    return this.request('/report', { method: 'POST', body: JSON.stringify(params) });
  }

  /** Searches the project's indexed code and documentation. */
  search(query: string, opts: { type?: 'code' | 'doc' | 'architecture'; limit?: number } = {}): Promise<{ query: string; count: number; results: SearchResult[] }> {
    const params = new URLSearchParams({ q: query });
    if (opts.type) params.set('type', opts.type);
    if (opts.limit) params.set('limit', String(opts.limit));
    return this.request(`/knowledge/search?${params}`);
  }

  /** Submits a proposed write action for human approval. Requires a secret key; never executes directly. */
  requestAction(params: { toolId: string; params?: Record<string, string | number | boolean>; reason?: string }): Promise<{ action: { id: string; status: string } }> {
    return this.request('/actions', { method: 'POST', body: JSON.stringify(params) });
  }

  /** Detected architecture. Requires a secret key. */
  architecture(): Promise<{ architecture: unknown; repository: unknown }> {
    return this.request('/architecture');
  }
}

export default ContextAI;
