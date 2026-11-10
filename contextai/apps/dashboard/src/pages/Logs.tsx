import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Badge, Empty, ErrorNote, PageHeader, Reveal, Tabs, statusTone, timeAgo } from '../components/ui'

type Tab = 'audit' | 'investigations' | 'jobs'

export default function Logs() {
  const [data, setData] = useState<any>(null)
  const [projects, setProjects] = useState<any[]>([])
  const [projectId, setProjectId] = useState('')
  const [tab, setTab] = useState<Tab>('audit')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { api.projects().then((d) => setProjects(d.projects)) }, [])
  useEffect(() => { api.logs(projectId || undefined).then(setData).catch((e) => setError(e.message)) }, [projectId])
  const name = (id: string) => projects.find((p) => p.id === id)?.name || id

  const rows: any[] = data?.[tab] || []
  return (
    <>
      <PageHeader eyebrow="Monitoring" title="Logs & audit" description="Every data query, tool call, indexing job and investigation is recorded with the actor and outcome." />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Tabs tabs={[{ id: 'audit', label: 'Audit log' }, { id: 'investigations', label: 'Investigations' }, { id: 'jobs', label: 'Indexing jobs' }]} value={tab} onChange={setTab} />
        <select className="input ml-auto !w-auto" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <ErrorNote error={error} />
      {data && rows.length === 0 && <Empty title="Nothing recorded yet" />}
      {rows.length > 0 && (
        <Reveal>
          <div className="card divide-y divide-white/[0.04] overflow-hidden">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center gap-4 px-5 py-3 text-sm transition hover:bg-white/[0.02]">
                <span className="w-20 shrink-0 text-xs text-zinc-600">{timeAgo(r.timestamp || r.createdAt)}</span>
                {tab === 'audit' && <>
                  <span className="w-40 shrink-0 font-mono text-xs text-violet-300">{r.action}</span>
                  <span className="min-w-0 flex-1 truncate text-zinc-300">{r.target}{r.error && <span className="text-red-300"> — {r.error}</span>}</span>
                  <span className="hidden w-36 truncate text-xs text-zinc-500 md:block">{name(r.projectId)}</span>
                  <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                </>}
                {tab === 'investigations' && <>
                  <span className="min-w-0 flex-1 truncate text-zinc-300">{r.question}</span>
                  <span className="hidden w-36 truncate text-xs text-zinc-500 md:block">{name(r.projectId)}</span>
                  <span className="w-16 text-right font-mono text-xs text-zinc-500">{r.durationMs}ms</span>
                  <Badge tone={statusTone(r.confidence)}>{r.confidence}</Badge>
                </>}
                {tab === 'jobs' && <>
                  <span className="w-32 shrink-0 font-mono text-xs text-zinc-400">{r.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-zinc-300">{r.error || (r.result ? `${r.result.filesIndexed} files · ${r.result.chunks} chunks` : r.repositoryUrl || '')}</span>
                  <span className="hidden w-36 truncate text-xs text-zinc-500 md:block">{name(r.projectId)}</span>
                  <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                </>}
              </div>
            ))}
          </div>
        </Reveal>
      )}
    </>
  )
}
