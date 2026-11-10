import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { Badge, Button, CountUp, Empty, ErrorNote, PageHeader, Reveal, statusTone, timeAgo } from '../components/ui'

export default function Overview() {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api.overview().then(setData).catch((e) => setError(e.message)) }, [])

  const stats = data ? [
    { label: 'Projects', value: data.counts.projects },
    { label: 'Data sources', value: data.counts.integrations },
    { label: 'Investigations', value: data.counts.investigations },
    { label: 'Errors', value: data.counts.errors },
  ] : []

  return (
    <>
      <PageHeader title="Overview" actions={<Link to="/projects"><Button>New project</Button></Link>} />
      <ErrorNote error={error} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(data ? stats : Array.from({ length: 4 })).map((s: any, i) => (
          <Reveal key={i} delay={i * 50}>
            <div className="card p-5">
              {s ? <>
                <div className="eyebrow">{s.label}</div>
                <div className={`mt-3 text-3xl font-semibold tracking-tight ${s.label === 'Errors' && s.value ? 'text-red-300' : 'text-white'}`}><CountUp value={s.value} /></div>
              </> : <><div className="skeleton h-3 w-16" /><div className="skeleton mt-4 h-7 w-10" /></>}
            </div>
          </Reveal>
        ))}
      </div>

      {data && (
        <div className="mt-6 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
          <Reveal>
            <div className="card h-full p-6">
              <div className="mb-4 flex items-center justify-between"><div className="eyebrow">Recent investigations</div><Link to="/logs" className="text-xs text-zinc-500 hover:text-zinc-200">View all →</Link></div>
              {data.recentInvestigations.length ? (
                <div className="divide-y divide-white/[0.04]">
                  {data.recentInvestigations.slice(0, 5).map((i: any) => (
                    <div key={i.id} className="flex items-center gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-zinc-200">{i.question}</div>
                        <div className="mt-0.5 text-xs text-zinc-500">{data.projects.find((p: any) => p.id === i.projectId)?.name} · {timeAgo(i.createdAt)}</div>
                      </div>
                      <Badge tone={statusTone(i.confidence)}>{i.confidence}</Badge>
                    </div>
                  ))}
                </div>
              ) : <Empty title="No investigations yet">Open a project and ask a question about its code or data.</Empty>}
            </div>
          </Reveal>

          <div className="space-y-4">
            <Reveal delay={80}>
              <div className="card p-6">
                <div className="eyebrow mb-4">Projects</div>
                {data.projects.length ? data.projects.map((p: any) => (
                  <Link key={p.id} to={`/projects/${p.id}`} className="-mx-2 flex items-center justify-between rounded-lg px-2 py-2.5 transition hover:bg-white/[0.03]">
                    <div><div className="text-sm text-zinc-200">{p.name}</div><div className="text-xs text-zinc-500">{p.integrations} data source{p.integrations === 1 ? '' : 's'} · {timeAgo(p.lastIndexedAt)}</div></div>
                    <Badge tone={statusTone(p.indexingStatus)}>{p.indexingStatus?.replace('_', ' ')}</Badge>
                  </Link>
                )) : <Empty title="No projects">Create a project to get started.</Empty>}
              </div>
            </Reveal>
            <Reveal delay={140}>
              <div className="card p-6">
                <div className="eyebrow mb-4">Data sources</div>
                {data.integrationHealth.length ? data.integrationHealth.map((h: any, i: number) => (
                  <div key={i} className="flex items-center justify-between py-1.5 text-sm">
                    <span className="truncate text-zinc-300">{h.name} <span className="text-zinc-600">· {h.type}</span></span>
                    <Badge tone={statusTone(h.status)}>{h.status}</Badge>
                  </div>
                )) : <div className="text-sm text-zinc-500">No data sources connected.</div>}
              </div>
            </Reveal>
          </div>
        </div>
      )}
    </>
  )
}
