# Integration guide

## 1. Create a project

In the console: **Projects → New project**. Save the `secretKey` — it is shown once. The `publicKey` can be viewed later.

## 2. Teach it the application

- **Code:** *Code & docs → Connect a GitHub repository*, or upload a folder. For private repositories set `GITHUB_TOKEN` on the server or pass `token` in the API call.
- **Data:** *Data → Add a data source*. Use a read-only database user and list the collections or tables the engine may read.
- **Meaning:** *Definitions*. Map the words your users say onto fields, values, filters or formulas.

## 3. Call it

### Browser (public key)

```ts
import { ContextAI } from "@contextai/sdk";

const ai = new ContextAI({ baseUrl: "https://contextai.example.com", projectId: "proj_…", publicKey: "pk_…" });
const result = await ai.ask({ question: "Which products are unavailable?" });
```

A public key can only `ask` and `search`. It cannot read configuration or change anything, so it is safe to ship.

### Embeddable chat widget

Install the SDK in the website, import its widget module once, and add the custom element to the page:

```bash
npm install @contextai/sdk
```

```ts
import "@contextai/sdk/widget";
```

```html
<contextai-widget
  base-url="https://contextai.example.com"
  project-id="proj_…"
  public-key="pk_…"
  title="Ask about our app"
></contextai-widget>
```

The widget is a self-contained, shadow-DOM chat panel. It asks through the public `/ask` API, preserves follow-up context for the current page, and provides quick prompts for configured live status checks. Never put a secret key or user-token signing secret in the page. If the API uses an origin allowlist, include the embedding site's origin in `CORS_ORIGINS`.

### Server (secret key)

```ts
const ai = new ContextAI({ baseUrl: process.env.CONTEXTAI_URL, projectId: process.env.CONTEXTAI_PROJECT, secretKey: process.env.CONTEXTAI_SECRET });
const report = await ai.report({ topic: "orders", timeRange: { from: "2026-10-01", to: "2026-10-31" } });
```

The SDK refuses a secret key in browser code.

### Any language

```bash
curl -X POST "$CONTEXTAI_URL/api/v1/projects/$PROJECT/ask" \
  -H "Content-Type: application/json" -H "X-Secret-Key: $SECRET" \
  -d '{"question":"Why are orders getting cancelled?"}'
```

## 4. Render results

Show `answer`, then `limitations` (always — they explain what could not be checked). For auditability render `findings[].evidence` as links into `evidence[]`. Treat `confidence` as a property of the evidence, not the model.

Google-grounded answers (`webSearch.searched: true`):

- Render `citations` as a numbered list that matches the `[n]` markers in `answer`.
- Render `searchSuggestions` unmodified next to the answer. The Gemini API terms require this. A sandboxed iframe works: `sandbox="allow-popups allow-popups-to-escape-sandbox"`, `srcdoc="<base target=_blank>" + searchSuggestions`.
- Show the answer only to the user who asked, and don't store it beyond their chat history.

The embeddable widget and the developer console already do all of this.

## 5. Keep knowledge fresh

Add a GitHub webhook (push events) pointing at `/api/v1/webhooks/github` with your `GITHUB_WEBHOOK_SECRET`, or call `connect/github` again from CI.

## Supported today

- Code: JavaScript/TypeScript (Express, NestJS, Fastify, Mongoose, Prisma, TypeORM, Sequelize, React/Next/Vue clients) and Python (FastAPI, Flask, Django route decorators).
- Data: MongoDB, PostgreSQL, uploaded JSON datasets.
- Tools: HTTP GET endpoints.
