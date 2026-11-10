# Development guide

## Local

```bash
cp .env.example .env     # JWT_SECRET, ENCRYPTION_KEY
npm install
npx playwright install chromium # required for JavaScript-rendered website crawling and crawler tests
npm run build -w @contextai/sdk
npm run dev              # API :4000 (node --watch), console :5173 (Vite, proxies /api)
npm run seed             # validation projects; the API must be running
```

## Tests

```bash
npm test
```

| Suite | Covers |
| --- | --- |
| `tests/units.test.js` | Query-spec validation, SQL generation, Mongo pipeline, formula parser, intent/time parsing, stemming, analyzer |
| `tests/engine.test.js` | Four differently shaped projects through the HTTP API: cancellations, failure rates, definitions, correlations, trends, profit formulas, filters, rankings, time ranges, honest limitations, code questions, isolation, scopes, allowlists, credential encryption, webhooks, SDK |
| `tests/connectors.test.js` | MongoDB end-to-end on a real `mongod` (downloaded by mongodb-memory-server on first run); PostgreSQL SQL executed on pg-mem |
| `tests/website.test.js` | Local JavaScript-rendered SPA, sitemap index, robots exclusion, duplicate/auth/failure reporting, honest job status, source truncation/redaction, and redirect checks |

All test data is synthetic and generated inside the tests, so expected answers are computed independently of the engine.

## Docker

```bash
cp .env.example .env     # fill secrets
docker compose up --build
```

API on `:4000`, console on `:8080` (nginx proxies `/api`). Platform metadata persists in the `contextai-data` volume.

## Adding a connector

Create `src/connectors/<type>.js` exporting `{ label, test(integration), discoverSchema(integration), query(integration, spec), closeAll? }` and register it in `src/connectors/index.js`. `integration.secrets` holds the decrypted config. Return `{ count, rows }`; aggregate rows are `{ key: { field: value }, count, <op>_<field> }`.

## Project layout rules

- The engine must not reference any domain term. Use field-role inference or business definitions.
- All data access goes through `executeQuery`.
- Every new response field is added to `SCHEMA_VERSION` docs and the SDK types.
