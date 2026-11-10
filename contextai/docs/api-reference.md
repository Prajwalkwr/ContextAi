# API reference

Base URL: `http://localhost:4000/api/v1`. JSON in and out. Errors are `{ "error": "…", "details"?: [] }`.

## Authentication

| Credential | Header | Scope |
| --- | --- | --- |
| Developer access token (2 h) | `Authorization: Bearer <jwt>` | All projects the developer owns |
| Project secret key | `X-Secret-Key: sk_…` | One project: ask, search, read, manage |
| Project public key | `X-Project-Key: pk_…` | One project: ask, search |

Requests without credentials get `401`. A key used on another project gets `403`.

## Auth

| Method | Path | Body |
| --- | --- | --- |
| POST | `/auth/register` | `{ email, password (≥8), name? }` |
| POST | `/auth/login` | `{ email, password }` → `{ token, refreshToken, user }` |
| POST | `/auth/refresh` | `{ refreshToken }` |
| GET | `/auth/me` | — |

## Projects

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects` | Owned projects |
| POST | `/projects` | `{ name, description?, websiteUrl?, repositoryUrl?, branch? }` → project, keys (secret shown once) and `jobs`: `repositoryUrl` queues GitHub indexing and `websiteUrl` queues a crawl; both can be given and are indexed side by side |
| GET | `/projects/overview` | Counts, health, recent activity |
| GET | `/projects/logs?projectId=` | Audit log, investigations, jobs |
| GET | `/projects/:id` | Project, profile, integrations (no credentials), definitions, tools, keys, jobs |
| PATCH / DELETE | `/projects/:id` | Delete cascades all project data |
| POST | `/projects/:id/keys` | New key pair |
| DELETE | `/projects/:id/keys/:keyId` | Revoke |

## Understanding and knowledge

| Method | Path | Body |
| --- | --- | --- |
| POST | `/projects/:id/connect/github` | `{ repositoryUrl, branch?, token? }` → `202 { job }`; `…/tree/<branch>` URLs set the branch |
| POST | `/projects/:id/knowledge/index` | `{ files: [{ path, content }] }` → `202 { job }` |
| GET | `/projects/:id/jobs` | Job status, progress, result or error |
| GET | `/projects/:id/knowledge/search?q=&type=&limit=` | `type`: `code`, `doc`, `architecture` |
| GET | `/projects/:id/architecture` | Detected stack, routes, client calls, models, auth, modules |

## Data

| Method | Path | Body |
| --- | --- | --- |
| POST | `/projects/:id/integrations` | `{ type: "mongodb"\|"postgresql"\|"mysql", name, config: { connectionString, database?, schema?, ssl? }, allowedCollections? }`, `{ type: "http", name, config: { mode: "rest"\|"graphql"\|"csv"\|"firestore", sources: [{ name, url, path?, query? }], headers? } }` or `{ type: "dataset", name, collections: { name: [records] }, synthetic? }` |
| GET | `/projects/:id/integrations` | — |
| POST | `/projects/:id/integrations/:intId/test` | Connection health |
| POST | `/projects/:id/integrations/:intId/schema` | Re-discover schema |
| PATCH | `/projects/:id/integrations/:intId` | `{ allowedCollections }` |
| DELETE | `/projects/:id/integrations/:intId` | — |
| POST | `/projects/:id/integrations/:intId/query` | A query spec (see architecture.md) |

## Business definitions

`POST /projects/:id/definitions`

```json
{ "term": "payment service", "meaning": "Gateway that processed the transaction", "collection": "transactions", "field": "gateway" }
{ "term": "failure", "meaning": "Failed transaction", "collection": "transactions", "field": "status", "value": "failed" }
{ "term": "unavailable", "meaning": "Out of stock", "collection": "products", "where": [{ "field": "stock", "op": "lte", "value": 0 }] }
{ "term": "profit", "meaning": "Gross profit", "collection": "menu_items", "formula": "(price - cost) * unitsSold" }
{ "term": "order activity", "meaning": "Orders per business", "collection": "businesses", "metricField": "orderCount" }
```

`DELETE /projects/:id/definitions/:defId`

## Tools

| Method | Path | Body |
| --- | --- | --- |
| POST | `/projects/:id/tools` | `{ name (snake_case), description, method?: GET\|POST\|PUT\|PATCH\|DELETE, url (may contain {param}), parameters?, requiredParameters?, headers? }` |
| POST | `/projects/:id/tools/:toolId/execute` | `{ params? }` — GET tools only; write tools return 403 |
| DELETE | `/projects/:id/tools/:toolId` | — |
| POST | `/projects/:id/actions` | `{ toolId, params, reason? }` → pending request (secret key or developer) |
| GET | `/projects/:id/actions` | Requests with status `pending`, `executed`, `failed`, `rejected` |
| POST | `/projects/:id/actions/:actionId/approve` \| `/reject` | Signed-in owner only; approve executes once with `Idempotency-Key: <actionId>` |

When a question is a command ("Refund order o12"), the response contains `proposedActions` with the matched write tool and extracted parameters. Nothing is executed until the request is submitted and approved.

## Website

`POST /projects/:id/connect/website` `{ url }` → `202 { job }`. Crawls up to `CRAWL_MAX_PAGES` (200 by default) same-origin pages and renders JavaScript with Playwright/Chromium. Read APIs using small JSON POST requests are supported only when the endpoint is clearly named as a read operation; form submission and other non-read requests remain blocked. GitHub indexing is limited by `GITHUB_MAX_FILES` (1,000 by default) and skips files larger than 600 KB. Website pages and code (GitHub or upload) are stored as separate sources of one project profile: re-indexing either replaces only that source. The indexing result reports skipped or inaccessible content; authentication walls, robots exclusions, anti-bot challenges, and content requiring user interaction may still prevent extraction.

## Intelligence

| Method | Path | Body |
| --- | --- | --- |
| POST | `/projects/:id/ask` | `{ question, timeRange?, conversationId?, history?: [{ question, answer }], context?: { userId?, userToken? } }` |
| POST | `/projects/:id/investigate` | `{ question, timeRange?, context? }`: the deterministic project engine only |
| POST | `/projects/:id/report` | `{ topic?, question?, timeRange? }` |
| GET | `/projects/:id/assistant` | Assistant settings and live metrics (`read`) |
| PATCH | `/projects/:id/assistant` | Owner only. `{ userScopes?: { collection: userIdField }, allowGeneralKnowledge?, timeZone?: IANA-time-zone, businessRules?: string[], searchConfiguration?: { webSearch?, allowedDomains? } }` |
| POST | `/projects/:id/assistant/user-token-secret` | Owner only. Rotates and returns (once) the HS256 secret used to sign end-user tokens |

### `/ask`: the assistant

`/ask` routes every question before answering. It returns everything `/investigate` returns, plus:

Assistant prose is returned in English, regardless of the input language. The server checks
language-identified responses and requests an English rewrite when needed; business names, code,
URLs, source titles and direct quotations are preserved. No streaming `/ask` endpoint is currently
provided.

```json
{
  "status": "success | insufficient_data | clarification_needed | refused | unauthorized",
  "conversationId": "conv_…",
  "standaloneQuestion": "Which payment methods does UdyogConnect support?",
  "route": { "intents": ["FOLLOW_UP", "PROJECT_SPECIFIC"], "sources": ["project_knowledge"], "method": "llm | heuristic | guard", "reason": "…", "personal": false },
  "citations": [{ "index": 1, "url": "https://…", "title": "…" }],
  "searchSuggestions": "<style>…</style><div class=\"container\">…</div>",
  "webSearch": { "provider": "google", "model": "gemini-3.8-flash", "mode": "required | optional", "searched": true, "grounded": true, "queries": ["latest React version"], "searches": 1, "fallbackFrom": null, "durationMs": 2400 },
  "retrieval": { "mode": "hybrid | keyword", "kept": 3, "discarded": [{ "source": "server/x.js", "coverage": 0.31, "similarity": null }] },
  "confidenceDetail": { "retrievalRelevance": "high | medium | none | not_used", "sourceReliability": "high | medium | low | none", "evidenceSufficiency": "sufficient | partial | insufficient", "answerConfidence": "high | medium | low" },
  "needsConfiguration": ["OPENAI_API_KEY or GEMINI_API_KEY"],
  "usage": { "llmCalls": 2, "inputTokens": 1830, "outputTokens": 140, "webSearches": 0, "models": ["gpt-4o-mini"] }
}
```

- **Google Search grounding.** When an answer was researched with Google Search (`answerMode: "google_search:<model>"`), `answer` is Gemini's grounded text, unmodified apart from removing links Google did not return. `[n]` markers refer to `citations[].index`; every citation URL comes from Google's grounding metadata. **Display `searchSuggestions` (HTML) with the answer, unmodified**: this is a Gemini API terms requirement. A sandboxed iframe works well: `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="<base target=_blank>…">`. Do not cache or show grounded answers to anyone other than the user who asked. `webSearch.searched: false` means Gemini answered a general question from its own knowledge. If a search fails, `status` is `insufficient_data`, `answerMode` is `google_search:failed` and `errorKind` is `quota | timeout | auth | not_configured | unavailable_model | upstream | network`; `auth` and `not_configured` also return `needsConfiguration: ["GEMINI_API_KEY"]`.
- `GET /projects/:id/assistant` also returns `ai: { generalKnowledge, languageModel }` and `webSearch: { provider: "google" | "openai" | null, google: { configured, models, today: { requests, queries, grounded, failures, quotaRejections, limit }, cooldowns, resultCaching: false } }`. `configured` only means `GEMINI_API_KEY` is present on the server; a live request is needed to verify the key is accepted. `metrics.googleSearch` counts this project's grounded requests.

- `intent` keeps its old meaning (the engine's analysis type) when project data or code was analysed. Otherwise it is the lower-cased route intent.
- **Conversation.** Pass back `conversationId` to continue a conversation. Conversations are bound to the caller (key or user plus end-user id) and expire after `CONVERSATION_TTL_MS`. Stateless clients can send `history` instead.
- **Personal data** ("show my orders") needs both of these:
  - The project owner sets `userScopes`, e.g. `{ "orders": "customerId" }`.
  - A verified end user. A secret key or developer token may assert `context.userId`. A public key (browser) must send `context.userToken`, an HS256 JWT `{ sub, aud: projectId }` signed by your backend with the secret from `/assistant/user-token-secret`.
  - Without both, the answer is `unauthorized`, and nothing is queried.
- `/ask` has its own rate limit (`ASK_RATE_LIMIT_MAX` per minute per caller).

Investigation response (`schemaVersion: "1.0"`):

```json
{
  "schemaVersion": "1.0",
  "status": "success | insufficient_data | clarification_needed",
  "investigationId": "inv_…",
  "projectId": "proj_…",
  "question": "…",
  "intent": "investigation | ranking | trend | metric | technical | general",
  "answer": "…",
  "findings": [{ "text": "…", "basis": "data | code | api", "evidence": ["E3"] }],
  "evidence": [{ "id": "E3", "kind": "live_database", "source": "Shop DB / orders", "purpose": "…", "query": "aggregate orders group by status limit 60", "recordCount": 3, "sample": [] }],
  "sources": [{ "type": "live_database", "name": "Shop DB / orders" }],
  "calculations": [{ "label": "…", "formula": "…", "inputs": "…", "result": "25%", "evidence": "E3" }],
  "limitations": ["…"],
  "recommendedActions": ["…"],
  "confidence": "high | medium | low",
  "confidenceBasis": "…",
  "timeRange": { "from": "2026-09-01", "to": "2026-09-30", "label": "…" },
  "plan": [{ "step": 1, "action": "receive", "detail": "…" }],
  "answerMode": "deterministic | llm:<model>:<prompt-version>",
  "durationMs": 120,
  "investigatedAt": "…"
}
```

Evidence kinds: `live_database`, `uploaded_dataset`, `synthetic_dataset`, `indexed_code`, `indexed_doc`, `indexed_page`, `business_definition`, `project_profile`, `registered_api`, `web_page` (assistant only).

## Webhooks

`POST /webhooks/github` — GitHub push events signed with `GITHUB_WEBHOOK_SECRET` (`X-Hub-Signature-256`). Re-indexes every project linked to the repository and branch.
