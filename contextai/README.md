# ContextAI

A reusable, project-aware intelligence engine. Connect any application's repository, data and business rules once; then ask it questions from an SDK, a REST API or the developer console and get answers computed from that project's real code and records — with evidence, calculations, limitations and an evidence-based confidence level.

**One engine, many projects.** Nothing in the engine is specific to a domain. Behaviour comes only from each project's indexed code, its discovered data schema, developer-confirmed business definitions and registered tools.

## What works today

| Area | Status |
| --- | --- |
| Project registration, developer accounts, key pairs | Working |
| GitHub repository indexing (public, or private with a token) as a background job | Working — pins the indexed commit and reports fetched, failed, excluded, oversized and over-limit files |
| File / folder upload indexing | Working |
| Code analysis: stack, routes with file:line, frontend → backend calls, models, auth, env keys | Working for JS/TS (Express, NestJS, Next…), Python (FastAPI, Flask, Django), PHP (Laravel, Symfony), Java/Kotlin (Spring), Ruby (Rails, Sinatra), C# (ASP.NET Core), Go (Gin, Echo, Fiber, Chi, net/http) |
| Website crawling (static sites, no repo needed): same-origin pages, sections, forms and content answers | Working — discovers links and robots/sitemap URLs, renders JavaScript with Playwright/Chromium, and reports blocked, duplicate, inaccessible and incomplete pages |
| Knowledge search (BM25, code-aware tokenisation, per-project) | Working |
| MongoDB connector (read-only) | Working — tested against a real `mongod` |
| PostgreSQL connector (Supabase, Neon, RDS…) | SQL tested on pg-mem; not yet run against a live server |
| MySQL / MariaDB connector (PlanetScale…) | SQL builder tested; not yet run against a live server |
| HTTP connector: REST JSON (Supabase REST, Firebase Realtime DB, any API), GraphQL (read-only queries), CSV (Google Sheets), Firestore REST | Working — tested against a mock server |
| Uploaded JSON datasets (optionally flagged synthetic) | Working |
| Business definitions: field mappings, value mappings, filters, formulas | Working |
| Investigation engine (intent → schema → plan → queries → analysis → verification → response) | Working |
| Cross-collection analysis: shared-key joins and time-window correlation (e.g. incidents ↔ failed transactions) | Working |
| Registered REST tools: GET runs during investigations; POST/PUT/PATCH/DELETE run only after owner approval, once, with an idempotency key | Working |
| JS/TS SDK (`packages/sdk`) | Working, built to `dist/`, not yet published to npm |
| GitHub push webhook (HMAC-verified re-index) | Working |
| Developer console | Working |
| Optional LLM answer composition (OpenAI) | Implemented; facts stay deterministic |
| Real-time Google Search grounding (Gemini API, `GEMINI_API_KEY`) for current information, with Google's citations and Search Suggestions | Implemented; project data, status and features are never searched |

Not implemented yet: durable BullMQ/Redis background jobs (jobs run in-process), multi-member teams and per-end-user roles, alerts, and a fully automated website-to-source relationship graph. Retrieval uses project-scoped BM25 and optional embedding similarity; an external vector database is not used. Any database that is not supported natively can be connected through an HTTP endpoint or a JSON/CSV export.

## Quick start

```bash
cp .env.example .env          # set JWT_SECRET and ENCRYPTION_KEY (32+ chars each)
npm install
npx playwright install chromium # required for JavaScript-rendered website crawling and crawler tests
npm run build -w @contextai/sdk
npm run dev                   # API on :4000, console on :5173
npm run seed                  # optional: UdyogConnect (real repo) + FinOpsX, with synthetic sample data
npm test                      # full test suite: engine, assistant, security, connectors, languages, actions, SDK
```

Seeded login: `demo@contextai.dev` / `contextai-demo`.

### Google Search (optional)

Current-information questions, such as "latest AI news", "latest React version" or "technology this week", are researched with Gemini's Grounding with Google Search.

1. Create a key at [Google AI Studio](https://aistudio.google.com/apikey) and set `GEMINI_API_KEY=` in `.env` (`contextai/.env` or `contextai/apps/api/.env`). The key is used only by the API server; never put it in the dashboard, widget or SDK.
2. Restart the API. The startup log shows the configured answer mode and `Web search: Google Search grounding (…)`. The project chat also reports whether the server has Gemini configured; this checks that a key is present, not that Google has accepted it.
3. Run a live test of real Google Search requests: `node apps/api/scripts/test-google-search.js`.

With Gemini configured, the assistant can answer general questions outside the connected project as well as current questions using Google Search. Website and repository content is indexed separately and used only for project-related questions. Website crawling defaults to 200 pages (`CRAWL_MAX_PAGES`) and up to 10 sitemap files (`CRAWL_MAX_SITEMAPS`); repository indexing defaults to 1,000 files (`GITHUB_MAX_FILES`) and 600,000 bytes per file (`GITHUB_MAX_FILE_BYTES`). Adjust these bounds for larger projects. The crawler renders JavaScript with Playwright/Chromium, waits for delayed SPA content and its in-flight data requests, and inspects controls and forms without clicking or submitting them. To support sites whose read APIs use POST, it permits only small JSON POSTs to clearly read-named endpoints (for example, `get-*` or `search`); other non-read requests are blocked. It follows robots.txt rules and only indexes same-origin pages. Pages that require authentication, fail extraction, duplicate another page, or remain JavaScript-only are reported; authentication walls, anti-bot challenges, and content requiring user interaction may still prevent extraction. Jobs finish as `completed_with_warnings` when the source has known gaps; they are not reported as fully indexed. Connect the repository for code behavior and a database/API integration for live records.

Time and calendar questions use the API server clock and IANA time-zone data locally, not Google Search. Set `DEFAULT_TIME_ZONE` in the API environment or the project owner's assistant `timeZone` setting (for example `Asia/Kathmandu`) for questions that omit a location. A requested location or valid IANA identifier takes precedence.

Defaults use the currently documented `gemini-3.8-flash` research model and `gemini-3.5-flash-lite` fast/fallback model. Available model IDs and grounding quotas depend on the Google account; run the live smoke test after setting the key rather than assuming that a configured key or model name guarantees access. All settings are in `.env.example`; routing and the terms-of-service handling are described in [docs/architecture.md](docs/architecture.md).

## How a question is answered

1. The caller is authenticated and the project is resolved server-side (a URL project id is never trusted alone).
2. Intent and time period are extracted (`investigation`, `ranking`, `trend`, `metric`, `technical`, `general`).
3. Matching business definitions and indexed code/docs are loaded.
4. Every connected integration's schema is discovered; collections and fields are ranked against the question using only the project's own names and definitions.
5. The engine plans and runs validated, read-only queries: counts, distributions, grouped breakdowns, averages, rankings, formula metrics, daily series.
6. Findings are derived deterministically; correlations are labelled as correlations; missing fields and records are reported as limitations.
7. Confidence is computed from evidence (records analysed, exactness, major limitations), not from a model.

Example on the seeded FinOpsX project — *"Which payment service has the highest failure rate?"*:

> 43 of 400 transactions records (10.8%) have status = "failed" (business definition "failure"). Highest failed rate by gateway: "Fonepay" at 17% (17 of 100). Others: ConnectIPS 9%, Khalti 9%, eSewa 8%. Among failed records, recorded errorCode values: "INSUFFICIENT_FUNDS" 20 (46.5%), "BANK_DECLINED" 13 (30.2%), "UPSTREAM_TIMEOUT" 10 (23.3%).

## Repository layout

```
apps/api           REST API and the engine
  src/engine         intent, catalog, investigation, formula, answer composition
  src/connectors     query spec + dataset / MongoDB / PostgreSQL / REST tools
  src/understanding  code analyzer, GitHub fetcher
  src/knowledge      indexing jobs, BM25 search
  scripts/           validation seed
apps/dashboard     React + Vite + Tailwind developer console
packages/sdk       @contextai/sdk
tests/             node:test suites
docs/              architecture, API, integration, security, development
```

See [docs/architecture.md](docs/architecture.md), [docs/api-reference.md](docs/api-reference.md), [docs/integration-guide.md](docs/integration-guide.md), [docs/security.md](docs/security.md) and [docs/development-guide.md](docs/development-guide.md).
