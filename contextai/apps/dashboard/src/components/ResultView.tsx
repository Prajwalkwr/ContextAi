import { Fragment, useState } from 'react'
import { api } from '../lib/api'
import { Badge, Button, Code, ErrorNote, Reveal } from './ui'

function ProposedAction({ projectId, action }: { projectId: string; action: any }) {
  const [params, setParams] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(action.params).map(([k, v]) => [k, String(v)])))
  const [state, setState] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setError(null)
    try {
      const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '').map(([k, v]) => [k, /^\d+(\.\d+)?$/.test(v) ? Number(v) : v]))
      await api.requestAction(projectId, { toolId: action.toolId, params: clean, reason: 'Requested from investigation' })
      setState('Submitted — approve it under Integrate → Action approvals.')
    } catch (e: any) { setError(e.message) }
  }
  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4">
      <div className="flex items-center gap-2 text-sm"><Badge tone="amber">{action.method}</Badge><span className="font-medium text-white">{action.tool}</span><span className="text-zinc-500">{action.description}</span></div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {Object.keys(params).concat(action.missing.filter((m: string) => !(m in params))).map((k) => (
          <div key={k}><label className="label">{k}</label><input className="input !py-1.5" value={params[k] ?? ''} onChange={(e) => setParams({ ...params, [k]: e.target.value })} /></div>
        ))}
      </div>
      <ErrorNote error={error} />
      <div className="mt-3 flex items-center gap-3">
        <Button className="!py-1.5 text-xs" onClick={submit} disabled={!!state}>Submit for approval</Button>
        <span className="text-xs text-zinc-500">{state || 'Nothing runs until a project owner approves it.'}</span>
      </div>
    </div>
  )
}

// Renders markdown links as anchors (http/https only) and keeps everything else as plain text.
function Prose({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g)
  return (
    <p className="whitespace-pre-line text-[15px] leading-relaxed text-zinc-100">
      {parts.map((part, i) => {
        const m = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/)
        return m
          ? <a key={i} href={m[2]} target="_blank" rel="noopener noreferrer nofollow" className="text-violet-300 underline decoration-violet-500/40 underline-offset-2 hover:text-violet-200">{m[1]}</a>
          : <Fragment key={i}>{part.replace(/\*\*([^*]+)\*\*/g, '$1')}</Fragment>
      })}
    </p>
  )
}

// Fenced code blocks keep their indentation; the rest is prose.
function AnswerText({ text }: { text: string }) {
  const blocks = text.split(/```[\w+-]*\n?([\s\S]*?)```/g)
  return (
    <div className="space-y-3">
      {blocks.map((block, i) => (i % 2 ? <Code key={i}>{block.replace(/\n$/, '')}</Code> : block.trim() && <Prose key={i} text={block.trim()} />))}
    </div>
  )
}

// Google's Search Suggestions must be shown exactly as returned with a grounded answer. The HTML is
// isolated in a sandboxed frame without scripts; its links open in a new tab.
function SearchSuggestions({ html }: { html: string }) {
  return (
    <iframe
      title="Google Search Suggestions"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={`<base target="_blank">${html}`}
      className="mt-3 h-16 w-full rounded-lg border-0 bg-transparent"
    />
  )
}

export function ResultView({ result }: { result: any }) {
  return (
    <div className="space-y-4">
      <Reveal>
        <div className="card overflow-hidden p-6">
          <AnswerText text={result.answer} />
          {result.citations?.length > 0 && (
            <ol className="mt-4 space-y-1 border-t border-white/[0.05] pt-3 text-xs text-zinc-400">
              {result.citations.map((c: any, i: number) => (
                <li key={c.url}><span className="text-zinc-600">[{c.index ?? i + 1}]</span> <a href={c.url} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-violet-200">{c.title}</a></li>
              ))}
            </ol>
          )}
          {result.searchSuggestions && <SearchSuggestions html={result.searchSuggestions} />}
          {result.webSearch?.searched && (
            <div className="mt-2 text-[11px] text-zinc-600">Grounded with Google Search · {result.webSearch.model}</div>
          )}
        </div>
      </Reveal>

      {result.proposedActions?.length > 0 && (
        <Reveal delay={30}>
          <div className="card space-y-3 p-6">
            <div className="eyebrow text-amber-400/80">Proposed action</div>
            {result.proposedActions.map((a: any) => <ProposedAction key={a.toolId} projectId={result.projectId} action={a} />)}
          </div>
        </Reveal>
      )}

    </div>
  )
}
