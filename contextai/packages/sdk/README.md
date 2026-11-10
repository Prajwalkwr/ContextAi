# @contextai/sdk

Client for the ContextAI project-aware intelligence engine.

```ts
import { ContextAI } from "@contextai/sdk";

const ai = new ContextAI({ baseUrl: "https://contextai.example.com", projectId: "proj_…", publicKey: "pk_…" });

const r = await ai.ask({ question: "Why are orders getting cancelled?" });
r.answer;        // plain-language answer
r.findings;      // each finding links to evidence ids
r.evidence;      // queries run, records, code references
r.calculations;  // formula, inputs, result
r.limitations;   // what could not be checked
r.confidence;    // derived from evidence
```

Methods: `ask`, `investigate`, `report`, `search`, `architecture` (secret key only).

Use `publicKey` in browsers (ask/search only). Use `secretKey` only on servers; the SDK throws if it is used in a browser.

## Embeddable chat widget

Install the SDK in your website:

```bash
npm install @contextai/sdk
```

Load the web component once in your frontend entry point, then place it where the chat launcher should appear:

```ts
import "@contextai/sdk/widget";
```

```html
<contextai-widget
  base-url="https://contextai.example.com"
  project-id="proj_…"
  public-key="pk_…"
  title="Ask about our app"
  welcome="Hi! Ask about our product or current service status."
></contextai-widget>
```

The widget uses the public `pk_` key and the project's `/ask` endpoint. It never accepts a secret key, renders assistant content as text, keeps conversation context for the open page, and includes quick prompts for live status questions. Configure `CORS_ORIGINS` on the ContextAI API to include the website's origin when restricting cross-origin requests. User-scoped questions require your backend to sign and supply the end-user token; never expose the user-token secret in browser code.

Build: `npm run build` (outputs `dist/`).
