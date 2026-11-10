# Architecture

## Assistant orchestration (`src/assistant`)

`POST /ask` passes through an orchestration layer before the engine. The layer works out what the user wants before deciding where to look.

```
question ─► guard ─► signals ─► router ─► sources (parallel) ─────────► answer ─► verify ─► respond
           (secrets,  (corpus     (LLM JSON   project knowledge: hybrid   (one LLM    (links ⊆ citations,
            override)  coverage,   schema;     retrieval + relevance gate  call, JSON) secrets redacted,
                       data vocab, heuristic   live data: engine, scoped               confidence split)
                       follow-up)  fallback)   web: Google Search grounding (Gemini),
                                                    or OpenAI Responses web_search
                                               model knowledge
```

| Module | Responsibility |
| --- | --- |
| `router.js` | Multi-label intents (`PROJECT_SPECIFIC`, `GENERAL_KNOWLEDGE`, `CURRENT_INFORMATION`, `LIVE_APPLICATION_DATA`, `ACTION_REQUEST`, `MIXED_QUERY`, `FOLLOW_UP`, `UNKNOWN`). It also selects sources, rewrites the question into a standalone form, and builds a project-focused retrieval query for mixed questions. The primary router is an OpenAI structured output. The fallback uses signals measured against the project's own corpus and data catalog. |
| `nlu.js` | Adds conservative local matching aids for known English typos and explicit Romanized Nepali / Devanagari phrases. The original message remains the one checked by input guards, retained in history, and sent to the answer model; interpretation is only used to improve routing and retrieval. |
| `retrieval.js` | BM25 plus optional embedding similarity, fused with reciprocal-rank fusion. It applies a metadata (type) filter, prefers prose for "how do I" questions and code for implementation questions, and removes duplicates. A **relevance gate** follows: every chunk must cover at least `RETRIEVAL_MIN_COVERAGE` of the question's IDF-weighted content terms, or reach `RETRIEVAL_MIN_SIMILARITY`. Chunks below both are discarded and reported. |
| `embeddings.js` | Semantic index per project, keyed by chunk hash. It is built in the background after indexing and embeds only chunks that changed. |
| `orchestrator.js` | Runs the selected sources in parallel, writes one grounded answer, verifies it, measures it, and caches suitable answers. |
| `time.js` | Answers current-time/date, requested IANA-zone, timezone-difference and weekday questions from the server clock without a model or web request. |
| `guard.js` | Refuses secret and instruction-override requests before any lookup. It redacts secrets from everything returned and wraps retrieved content as untrusted data. |
| `projectConfig.js` | The per-project configuration: `projectId`, `projectName`, `projectDescription`, `projectKnowledge`, `availableTools`, `apiIntegrations`, `databasePermissions`, `businessRules`, `userContext`, `timeZone` and `searchConfiguration`. The engine never changes between deployments; only this does. |
| `conversation.js` | Conversation memory bound to (project, caller). Prompt history keeps the newest turns within a 12,000-character budget, including resolved standalone topics. |
| `judgment.js` | Shared instructions for independent, evidence-aware decisions across agent, direct, docs, revision and Google research prompts; adds no separate model call. |

### Independent judgment

Decision and opinion answers are instructed to test assumptions, identify material risks and alternatives, distinguish facts from assessments, give a clear practical recommendation, and revise it when evidence changes. Project claims remain bound to retrieved project evidence and validated tool results. The prompts and scenario benchmark are described in [independent-judgment.md](./independent-judgment.md); the benchmark's automatic text indicators are not a semantic quality score.

### Natural-language matching

The assistant sends the user's original text to its existing model and does not add a spelling-correction request or model call. Small local aliases and explicit Nepali phrase patterns supplement deterministic intent signals and retrieval queries. They do not modify the stored/displayed user message or relax the input guard; user-specific records still require verified identity. `tests/nlu-evaluation.test.js` exercises 100 fixed messages across typos, English, incomplete follow-ups, Romanized Nepali, Devanagari, and mixed-language input. Its pass count measures these local matching expectations, not general language-model accuracy or broad Nepali fluency.

### Google Search grounding (`lib/googleSearch.js`, `assistant/searchPolicy.js`)

Current information comes from Gemini's built-in `google_search` tool, called through the official `@google/genai` SDK (Interactions API, `store: false`) on the server. `GEMINI_API_KEY` never reaches a browser.

Time questions are handled before routing: a requested city, country or IANA time-zone identifier is resolved to an IANA zone, and `Intl` computes the date, current UTC offset (including daylight-saving transitions) and answer from the server clock. The owner's `timeZone` assistant setting or `DEFAULT_TIME_ZONE` environment variable sets the default when no location is specified; the fallback is UTC.

**When to search** (`searchNeed`), decided before any model call:

| Question | Search | Source |
| --- | --- | --- |
| Greetings, small talk | none | conversation |
| This project's records, ratings, rankings ("Which business has the highest rating?") | none | validated data tools on the real database |
| This project's live status ("What is the current website status?") | none | live health checks |
| This project's features and code ("What is UdyogConnect?") | none | indexed repository, website and project card |
| News, releases, "latest", "this week" | required | Google Search |
| Follow-up to a web-researched answer | required | Google Search |
| Stable general knowledge ("How many moons does Mars have?") | optional | the model answers; Gemini searches only if verification helps |

The web is never a substitute for the project's own sources: those questions do not get the web tool at all.

**Orchestration.** A Gemini request cannot also call ContextAI's own function tools, so mixed questions run in steps:

1. Pure current-information questions go straight to Gemini with search required. There is no router or agent round-trip.
2. Mixed questions ("Does UdyogConnect support eSewa, and what did eSewa announce recently?") run the project tools first: agent tools or the router's sources. Gemini then runs last, receiving their findings as `PROJECT CONTEXT`, and its grounded answer is the reply.
3. Without a main OpenAI model, Gemini also answers general questions, with search optional, on the cheaper `GEMINI_FAST_MODEL`.

**Models and limits.**

- Research questions use `GEMINI_SEARCH_MODEL`, and general questions use `GEMINI_FAST_MODEL`.
- On an unavailable model, account quota, or rate limits, the request retries on `GEMINI_SEARCH_FALLBACK_MODEL` (default `gemini-3.5-flash-lite`). The failed model then cools down so later requests skip it. Google model availability and grounding quotas vary by account; verify with a live request.
- `GEMINI_SEARCH_DAILY_LIMIT` caps grounded requests per UTC day, and `GEMINI_TIMEOUT_MS` bounds each request.
- Usage is counted per project in `metrics.googleSearch` and globally in `GET /assistant` → `webSearch.google.today`.

**Terms of service.** These apply to Grounding with Google Search:

- Grounded results are shown only to the user who asked, together with Google's Search Suggestions, and without rewriting by another model.
- They are not cached. The answer cache already excludes `web_search` routes, and `googleSearch.js` has no result cache.
- When a later turn goes to the OpenAI model, the grounded turn is replaced by a one-line note of its topic (`forOtherModels`). Grounded text is resubmitted only to Gemini.

### Why the old assistant answered "How many moons does Mars have?" with UdyogConnect code

The engine always ran keyword search and treated any match as relevant. When nothing matched, it fell back to static code analysis. Now:

- The router sends that question to `model_knowledge` only.
- Even when retrieval runs, unrelated chunks are rejected by the coverage gate.
- Static code analysis is used only for implementation or site-structure questions.

`apps/api/scripts/eval-retrieval.js` calibrates the gate against labelled project and general questions on a real indexed project. On UdyogConnect's 771 chunks, project questions score 1.00 and general questions at most 0.46, so the default of 0.6 classifies all 24 correctly. Re-run it after changing the tokenizer, or with `OPENAI_API_KEY` set to calibrate similarity.

### Confidence

Confidence is no longer derived from retrieval scores. `confidenceDetail` reports four separate measures:

- **retrievalRelevance:** did the project evidence pass the gate?
- **sourceReliability:** live database or registered API is high; documents and code are medium; a synthetic dataset is low; web reliability depends on the number of citations; model knowledge is medium.
- **evidenceSufficiency:** taken from the answer model's own `answers_question` and `missing_information` check, or from the engine's limitations.
- **answerConfidence:** the lowest of the levels that apply, capped by sufficiency.

### Without `OPENAI_API_KEY`

Project data and code questions are answered deterministically, exactly as before. With `GEMINI_API_KEY` set, current-information and general questions are answered by Gemini (see above). Without either key, general, current and mixed questions are routed correctly but answered with `insufficient_data` and `needsConfiguration` (`OPENAI_API_KEY` for general questions, `GEMINI_API_KEY` for web search). They are never answered from unrelated project files. The heuristic router cannot tell, for example, that "Explain hooks" is a general React question. The language-model router handles such cases.

## Components

```
            SDK (pk_ / sk_)      REST API      Developer console (JWT)
                     \              |              /
                      ── authenticate → requireProject(scope) ──
                                    |
                        Central engine (src/engine)
        intent → definitions → knowledge → schema catalog → plan
             → validated queries → analysis → verification → answer
               |                    |                       |
      Knowledge (src/knowledge)  Connectors (src/connectors)  Understanding (src/understanding)
      BM25 over per-project      one QuerySpec, translated    analyzer + GitHub fetcher,
      chunks with line ranges    per backend, allowlisted     run as indexing jobs
```

## Why the engine stays reusable

The engine never references a domain. It works from four per-project inputs:

| Input | Source | Used for |
| --- | --- | --- |
| Project profile | Repository analysis | Technical answers with file:line references |
| Knowledge chunks | Indexed code and docs | Retrieval and source references |
| Data catalog | Live schema discovery of each integration | Choosing collections, fields, outcomes, dimensions, metrics |
| Business definitions | Developer-confirmed | Mapping vocabulary ("payment service" → `gateway`), values ("failure" → `status = failed`), filters, formulas |

Field roles are inferred from naming conventions (`status`/`state` = outcome, `*reason*`/`*error*`/`*code*` = explanatory, `createdAt`/`date` = time, `name`/`title` = label). Inferred targets are labelled "inferred … confirm with a business definition" in the answer; definitions always win.

Adding a project never changes engine code. Adding a database type means implementing `test`, `discoverSchema` and `query(spec)` in a new connector.

## The query spec

All data access — including any future LLM-planned access — goes through `validateSpec` (`src/connectors/querySpec.js`):

- operations: `find`, `count`, `aggregate` (grouped count/sum/avg/min/max)
- collection must be allowlisted and present in the discovered schema
- every field must exist in the schema and match `^[A-Za-z_][A-Za-z0-9_]*$`
- operators are a fixed list; values are primitives only (so `{ $where: … }` cannot be expressed)
- limit capped at 1000

MongoDB receives only `find`, `countDocuments` and a `$match/$group/$sort/$limit` pipeline. PostgreSQL receives quoted identifiers and bind parameters inside `BEGIN READ ONLY` with a 5 s statement timeout.

## Investigation analyses

| Analysis | Trigger |
| --- | --- |
| Outcome rate | A field value matches the question or a definition (e.g. `status = cancelled`) |
| Breakdown by dimension | The question or a definition names a categorical field |
| Recorded causes | Explanatory fields among target records; missing values become limitations |
| Concentration | Target rate in a group ≥ 1.5× and +10 points over the overall rate |
| Numeric comparison | Averages differ ≥ 25% between target and other records (reported as correlation) |
| Ranking | "which/top/least" with a metric field |
| Formula metric | Definition formula, null-safe; records missing inputs are excluded and listed |
| Filter definition | Definition `where` conditions; matching records listed |
| Trend | Daily series of a metric, rate or count; largest day-over-day change |

## Confidence

- **high**: exact computation over every record in scope with no major limitation, or ≥100 records analysed with no major limitation
- **medium**: ≥20 records, or static code analysis with ≥3 references
- **low**: anything less, or any major limitation on a sampled analysis

## Trade-offs

- **Deterministic planner instead of LLM planning.** Every number is reproducible and testable, and prompt injection cannot change which queries run. Cost: vocabulary that is not in the schema needs a business definition.
- **Hybrid project knowledge retrieval.** BM25 and exact path tokens are always available; optional embedding similarity is fused with reciprocal-rank fusion and a relevance gate. Embeddings are stored in per-project JSON files rather than an external vector database.
- **JSON-file metadata store and in-process jobs.** Zero infrastructure for the MVP; every accessor is project-scoped, so swapping to PostgreSQL / BullMQ only touches `lib/db.js` and `knowledge/indexer.js`.
- **Pattern-based code analysis instead of Tree-sitter.** Covers the common Express / NestJS / Mongoose / Prisma / FastAPI conventions with file:line evidence; unusual frameworks may be missed.

## Cross-collection analysis

When a question names two collections, both are analysed, then linked:

- **Key join** — a field in one collection whose values overlap (≥ 50%) a field in the other, e.g. `transactions.gateway` ↔ `incidents.service`, `orders.business` ↔ `businesses.name`.
- **Time window** — when both have a time field, the outcome rate inside each event's window (start + a `duration*` field in minutes, or the same day) is compared with the rate outside it.

Results are reported as co-occurrence, never as proven cause.

## Write actions

Write tools call the application's own API, so its validation and permissions still apply. The engine only *proposes* them; a request must be submitted and approved by a signed-in project owner, then runs once with an idempotency key. Public keys cannot submit requests.

## Website and repository ingestion

Website discovery begins with the connected URL, same-origin links, `robots.txt` sitemap directives, and standard sitemap/index files. The crawler respects robots rules and same-origin scope, normalizes tracking parameters, removes duplicate page text, and records each discovered URL's extraction outcome. When Playwright and its Chromium browser are installed, pages are rendered after DOM readiness, scrolled a bounded number of times, and inspected for visible text, headings, links, forms, and controls. It does not click controls or submit forms. Routes that still return an SPA shell are not indexed as successfully extracted pages.

GitHub indexing pins a commit SHA, enumerates its recursive tree, and records fetched, failed, excluded, binary, oversized, over-limit, and truncated-tree files. Source chunks retain file paths, line ranges, project origin, and source version; source credentials are redacted before analysis and embedding. Code and website chunks are replaced independently.

Per-source coverage is available in the project profile and job result. Runs with known omissions finish as `completed_with_warnings`; inaccessible/authenticated pages and failed source fetches remain visible rather than being described as successfully indexed. Website pages are rendered with Playwright and delayed SPA content is given time to settle. The browser allows safe methods plus small JSON POSTs to clearly read-named endpoints; other non-read requests and form submissions remain blocked. Defaults are 200 pages and 1,000 GitHub files; configure page/file bounds with `CRAWL_MAX_PAGES`, `CRAWL_MAX_SITEMAPS`, `GITHUB_MAX_FILES`, and `GITHUB_MAX_FILE_BYTES`. Authentication walls, anti-bot challenges, robots exclusions, and content requiring user interaction remain out of scope.

## Coverage for any website

| Website has | How ContextAI understands it |
| --- | --- |
| A repository | GitHub indexing or folder upload (JS/TS, Python, PHP, Java/Kotlin, Ruby, C#, Go, HTML) |
| No repository (static or hosted site) | Website crawler |
| MongoDB / PostgreSQL / MySQL | Native read-only connectors |
| Supabase, Firebase, Firestore, Google Sheets, GraphQL, any REST API | HTTP connector |
| Any other store | Expose a read endpoint (HTTP connector) or upload an export |

## Known limitations

- Local JavaScript crawling requires `npx playwright install chromium`; the API Docker image installs Chromium. Pages that require login, CAPTCHA completion, or an inaccessible browser state are not bypassed.
- Crawling observes visible controls but does not inspect every tab/modal state or run pagination/load-more actions. The system does not yet maintain scheduled website recrawls or a durable incremental index version.
- Website feature records are evidence from the observed page; an automatic, verified page → component → API → model relationship graph is not implemented.
- MongoDB dates stored as `Date` objects are compared against ISO strings when a time range is applied, which may not match; string dates work.
- HTTP sources are loaded fully (up to 10,000 records per collection, cached 60 s) and queried in memory.
- Server-side HTTP requests block known private IP/host patterns and revalidate redirect targets unless `ALLOW_PRIVATE_NETWORK=true`; DNS rebinding is not mitigated.
