import { apiBase } from '../lib/api'
import { Code, PageHeader, Reveal } from '../components/ui'

const endpoints = [
  ['POST', '/projects', 'Create a project (returns keys once)', 'user'],
  ['POST', '/projects/:id/connect/github', 'Index a GitHub repository (background job)', 'user · sk'],
  ['POST', '/projects/:id/knowledge/index', 'Index uploaded files', 'user · sk'],
  ['GET', '/projects/:id/knowledge/search?q=', 'Search indexed code and docs', 'user · sk · pk'],
  ['POST', '/projects/:id/integrations', 'Connect MongoDB, PostgreSQL or a dataset', 'user · sk'],
  ['POST', '/projects/:id/definitions', 'Add a business definition', 'user · sk'],
  ['POST', '/projects/:id/ask', 'Ask the assistant (project, data, general or current questions)', 'user · sk · pk'],
  ['POST', '/projects/:id/investigate', 'Run the evidence engine directly on project data', 'user · sk · pk'],
  ['POST', '/projects/:id/report', 'Summarise a topic for a period', 'user · sk · pk'],
  ['GET', '/projects/:id/assistant', 'Read the assistant configuration', 'user · sk'],
  ['PATCH', '/projects/:id/assistant', 'Update assistant settings (owner)', 'user'],
  ['POST', '/projects/:id/assistant/user-token-secret', 'Rotate the secret that signs end-user tokens', 'user'],
  ['POST', '/projects/:id/integrations/:intId/query', 'Validated structured query', 'user · sk'],
  ['POST', '/webhooks/github', 'Re-index on push (HMAC verified)', 'GitHub'],
]

export default function Docs() {
  return (
    <>
      <PageHeader eyebrow="Developers" title="Integrate ContextAI" description="Install the SDK in any JavaScript or TypeScript app, or call the REST API from any language." />
      <div className="space-y-4">
        <Reveal>
          <div className="card grid gap-6 p-6 lg:grid-cols-2">
            <div>
              <div className="text-base font-semibold text-white">JavaScript / TypeScript SDK</div>
              <p className="mt-1 text-sm text-zinc-500">Build it from <span className="font-mono">packages/sdk</span> (or publish it to your registry), then:</p>
              <div className="mt-4"><Code>{`import { ContextAI } from "@contextai/sdk";

const ai = new ContextAI({
  baseUrl: "${apiBase}",
  projectId: "proj_…",
  publicKey: "pk_…",
});

const r = await ai.ask({
  question: "Why did cancellations rise?",
  timeRange: { from: "2026-10-01", to: "2026-10-31" },
});

// Follow-ups continue the same conversation.
const next = await ai.ask({
  question: "What about last week?",
  conversationId: r.conversationId,
});`}</Code></div>
            </div>
            <div>
              <div className="text-base font-semibold text-white">Response shape (schemaVersion 1.0)</div>
              <p className="mt-1 text-sm text-zinc-500">Every answer is backed by evidence you can render or audit.</p>
              <div className="mt-4"><Code>{`{
  "status": "success" | "insufficient_data" | "clarification_needed"
          | "refused" | "unauthorized",
  "answer": "…",
  "conversationId": "conv_…",
  "route": { "intents": ["LIVE_APPLICATION_DATA"], "sources": ["live_data"] },
  "findings": [{ "text", "basis", "evidence": ["E3"] }],
  "evidence": [{ "id", "kind", "source", "query", "sample" }],
  "calculations": [{ "label", "formula", "inputs", "result" }],
  "citations": [{ "title", "url" }],
  "limitations": ["…"],
  "recommendedActions": ["…"],
  "needsConfiguration": ["OPENAI_API_KEY"],
  "confidence": "high" | "medium" | "low",
  "confidenceBasis": "…"
}`}</Code></div>
            </div>
          </div>
        </Reveal>
        <Reveal delay={80}>
          <div className="card overflow-hidden">
            <div className="px-6 pt-6"><div className="text-base font-semibold text-white">REST API</div><p className="mt-1 text-sm text-zinc-500">Base <span className="font-mono">{apiBase}/api/v1</span>. Authenticate with a developer token, <span className="font-mono">X-Secret-Key</span> (server only) or <span className="font-mono">X-Project-Key</span> (browser, ask/search only).</p></div>
            <div className="mt-4 divide-y divide-white/[0.04]">
              {endpoints.map(([m, path, desc, auth]) => (
                <div key={path + m} className="grid grid-cols-[60px_1fr] items-center gap-x-4 gap-y-0.5 px-6 py-3 text-sm md:grid-cols-[60px_1.2fr_1fr_120px]">
                  <span className={`font-mono text-xs ${m === 'GET' ? 'text-sky-300' : 'text-emerald-300'}`}>{m}</span>
                  <span className="font-mono text-xs text-zinc-200">{path}</span>
                  <span className="col-start-2 text-zinc-400 md:col-start-auto">{desc}</span>
                  <span className="col-start-2 text-xs text-zinc-600 md:col-start-auto">{auth}</span>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </>
  )
}
