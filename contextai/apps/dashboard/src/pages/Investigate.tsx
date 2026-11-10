import { FormEvent, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Button, Empty, ErrorNote, PageHeader, Reveal } from '../components/ui'
import { ResultView } from '../components/ResultView'

function LiveStatusCard({ project, onPrompt }: { project?: { name?: string; statusUrl?: string }; onPrompt: (prompt: string) => void }) {
  const statusUrl = project?.statusUrl
  if (!statusUrl) return null

  const quickPrompts = ['Check current status', 'Any active issues?']

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.05] px-4 py-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-300/80">Live status</div>
          <div className="mt-1 text-sm font-medium text-white">{project?.name || 'This project'}</div>
        </div>
        <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-300">Ready</span>
      </div>
      <div className="p-4">
        <div className="flex flex-wrap gap-2">
          {quickPrompts.map((prompt) => (
            <button key={prompt} type="button" onClick={() => onPrompt(prompt)} className="rounded-full border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-300 transition hover:border-violet-400/50 hover:bg-violet-500/10 hover:text-violet-200">{prompt}</button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function AskPanel({ projectId, integrations, indexed, project }: { projectId: string; integrations: any[]; indexed: boolean; project?: { name?: string; statusUrl?: string } }) {
  const [question, setQuestion] = useState('')
  const [range, setRange] = useState({ from: '', to: '' })
  const [turns, setTurns] = useState<{ question: string; result: any }[]>([])
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const result = turns[turns.length - 1]?.result
  const reset = () => { setTurns([]); setConversationId(undefined) }
  useEffect(() => {
    setTurns([])
    setConversationId(undefined)
  }, [projectId])
  const ask = async (e?: FormEvent, q = question) => {
    e?.preventDefault()
    if (!q.trim()) return
    setQuestion('')
    setError(null)
    setLoading(true)
    try {
      const r = await api.ask(projectId, q, range.from && range.to ? range : undefined, conversationId)
      setConversationId(r.conversationId)
      setTurns((t) => [...t, { question: q, result: r }])
    } catch (err: any) { setQuestion(q); setError(err.message) } finally { setLoading(false) }
  }

  return (
    <div className="space-y-5">
      <LiveStatusCard project={project} onPrompt={(prompt) => ask(undefined, prompt)} />
      <Reveal>
        <form onSubmit={ask} className="card p-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className="flex-1 bg-transparent px-4 py-3 text-[15px] text-white outline-none placeholder:text-zinc-600" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={turns.length ? 'Ask a follow-up…' : 'Ask about this project, its data, or anything else…'} autoFocus />
            <Button type="submit" loading={loading} className="sm:px-6">Ask</Button>
          </div>
          <div className="flex items-center justify-end border-t border-white/[0.04] px-3 pb-1 pt-2.5">
            <details className="ml-auto text-xs text-zinc-500">
              <summary className="cursor-pointer select-none hover:text-zinc-300">Date range</summary>
              <div className="mt-2 flex items-center gap-1.5">
                <input aria-label="Start date" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className="rounded-md border border-white/[0.06] bg-transparent px-1.5 py-1 text-zinc-300" />
                <span>→</span>
                <input aria-label="End date" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className="rounded-md border border-white/[0.06] bg-transparent px-1.5 py-1 text-zinc-300" />
              </div>
            </details>
          </div>
        </form>
      </Reveal>
      <ErrorNote error={error} />
      {turns.length > 0 && !loading && <button type="button" onClick={reset} className="text-xs text-zinc-500 hover:text-zinc-300">Start a new conversation</button>}
      {loading && <div className="skeleton h-32" role="status" aria-label="Answering question" />}
      {[...turns].reverse().map((t) => (
        <div key={t.result.investigationId} className="space-y-2">
          <p className="px-1 text-sm text-zinc-400"><span className="text-zinc-600">You:</span> {t.question}</p>
          <ResultView result={t.result} />
        </div>
      ))}
      {!result && !loading && !integrations.length && !indexed && <Empty title="Connect a source to get started" />}
    </div>
  )
}

export default function Investigate() {
  const [projects, setProjects] = useState<any[]>([])
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<any>(null)

  useEffect(() => { api.projects().then((d) => { setProjects(d.projects); if (d.projects[0]) setSelected(d.projects[0].id) }) }, [])
  useEffect(() => { if (selected) api.project(selected).then(setDetail) }, [selected])

  return (
    <>
      <PageHeader title="Investigate" description="Ask questions across your projects." />
      {projects.length === 0 ? <Empty title="No projects yet">Create a project first.</Empty> : (
        <>
          <div className="mb-5 flex flex-wrap gap-2">
            {projects.map((p) => (
              <button key={p.id} onClick={() => setSelected(p.id)} aria-pressed={selected === p.id} className={`rounded-xl border px-4 py-2 text-sm transition ${selected === p.id ? 'border-butter bg-butter text-ink-950' : 'border-white/[0.08] text-zinc-400 hover:border-butter/40 hover:text-butter'}`}>{p.name}</button>
            ))}
          </div>
          {detail?.project.id === selected && <AskPanel projectId={selected} integrations={detail.integrations} indexed={!!detail.profile} project={detail.project} />}
        </>
      )}
    </>
  )
}
