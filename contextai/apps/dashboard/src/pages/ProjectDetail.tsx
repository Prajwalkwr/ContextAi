import { ReactNode, useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, apiBase } from '../lib/api'
import { readFolder } from '../lib/connect'
import { Badge, Button, Code, Empty, ErrorNote, PageHeader, Reveal, Tabs, statusTone, timeAgo } from '../components/ui'
import { AskPanel } from './Investigate'

type Tab = 'ask' | 'understand' | 'integrate'
const TABS: { id: Tab; label: string }[] = [
  { id: 'ask', label: 'Investigate' },
  { id: 'understand', label: 'Code & docs' },
  { id: 'integrate', label: 'Integrate' },
]

export default function ProjectDetail() {
  const { id } = useParams() as { id: string }
  const navigate = useNavigate()
  const location = useLocation()
  const [data, setData] = useState<any>(null)
  const [tab, setTab] = useState<Tab | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [welcome, setWelcome] = useState<{ credentials?: any; connectError?: string | null } | null>(() => (location.state as any) || null)

  const load = useCallback(() => api.project(id).then(setData).catch((e) => setError(e.message)), [id])
  useEffect(() => { load() }, [load])
  // Drop the one-time credentials from history so a refresh or back navigation never shows them again.
  useEffect(() => { if (location.state) navigate(location.pathname, { replace: true, state: null }) }, [])
  useEffect(() => {
    if (data && tab === null) setTab(data.profile ? 'ask' : 'understand')
  }, [data, tab])

  const running = data?.jobs?.some((j: any) => ['queued', 'running'].includes(j.status))
  useEffect(() => {
    if (!running) return
    const t = setInterval(load, 1500)
    return () => clearInterval(t)
  }, [running, load])

  if (error) return <ErrorNote error={error} />
  if (!data || !tab) return <div className="space-y-4"><div className="skeleton h-10 w-64" /><div className="skeleton h-64" /></div>
  const { project } = data

  return (
    <>
      <Link to="/projects" className="mb-4 inline-block text-xs text-zinc-500 hover:text-zinc-300">← Projects</Link>
      <PageHeader
        title={project.name}
        description={project.description}
        actions={<Button variant="danger" onClick={async () => { if (confirm(`Delete ${project.name} and all of its knowledge, data connections and keys?`)) { await api.deleteProject(id); navigate('/projects') } }}>Delete</Button>}
      />
      {welcome && <Welcome id={id} welcome={welcome} onDone={() => setWelcome(null)} />}
      <SetupGuide id={id} data={data} go={setTab} />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
        <div className="ml-auto flex gap-2">
          <Badge tone={statusTone(project.indexingStatus)}>{running ? 'indexing…' : project.indexingStatus?.replace('_', ' ')}</Badge>
        </div>
      </div>

      {tab === 'ask' && <AskPanel projectId={id} integrations={data.integrations} indexed={!!data.profile} project={project} />}
      {tab === 'understand' && <Understand id={id} data={data} reload={load} />}
      {tab === 'integrate' && <Integrate id={id} data={data} reload={load} />}
    </>
  )
}

function Welcome({ id, welcome, onDone }: { id: string; welcome: { credentials?: any; connectError?: string | null }; onDone: () => void }) {
  const c = welcome.credentials
  const keys = c ? `projectId: ${id}\npublicKey: ${c.publicKey}\nsecretKey: ${c.secretKey}` : ''
  const [copied, setCopied] = useState(false)
  return (
    <div className="mb-6 space-y-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] p-5 animate-fade-up">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 text-sm font-medium text-emerald-300">Project created. Copy the secret key now; it is shown only once.</div>
        {c && <Button className="!px-3 !py-1.5 text-xs" onClick={() => { navigator.clipboard.writeText(keys); setCopied(true) }}>{copied ? 'Copied' : 'Copy keys'}</Button>}
        <Button variant="ghost" className="!px-3 !py-1.5 text-xs" onClick={onDone}>I’ve saved it</Button>
      </div>
      {c && <Code>{keys}</Code>}
      {welcome.connectError && <ErrorNote error={`Connecting the source failed: ${welcome.connectError}. You can retry from the Code & docs tab.`} />}
    </div>
  )
}

type StepState = 'done' | 'active' | 'failed' | 'warning' | 'todo'
function Step({ n, state, title, detail, action }: { n: number; state: StepState; title: string; detail: ReactNode; action?: ReactNode }) {
  const dot = {
    done: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
    active: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    warning: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    failed: 'border-red-500/30 bg-red-500/10 text-red-300',
    todo: 'border-white/[0.1] bg-white/[0.03] text-zinc-400',
  }[state]
  return (
    <div className="flex gap-3 rounded-xl border border-white/[0.05] bg-black/20 p-4">
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${dot}`}>
        {state === 'done' ? '✓' : state === 'active' ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-amber-300/30 border-t-amber-300" /> : state === 'failed' || state === 'warning' ? '!' : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-zinc-100">{title}</div>
        <div className="mt-0.5 text-xs leading-relaxed text-zinc-500">{detail}</div>
        {action && <div className="mt-2.5">{action}</div>}
      </div>
    </div>
  )
}

type Origin = 'code' | 'website'
const CODE_JOBS = ['github-index', 'upload-index']

function sourceStatus(data: any, origin: Origin) {
  const p = data.profile
  const part = p?.parts ? p.parts[origin] || null : p && (p.source === 'website') === (origin === 'website') ? p : null
  const job = data.jobs?.find((j: any) => (origin === 'website' ? j.kind === 'website-crawl' : CODE_JOBS.includes(j.kind)))
  const running = !!job && ['queued', 'running'].includes(job.status)
  const failed = !running && job?.status === 'failed'
  const count = part?.architecture?.fileCount
  const skipped = part?.skipped || {}
  const coverageWarnings = []
  let hasWarnings = false
  const warn = (message: string) => { coverageWarnings.push(message); hasWarnings = true }
  if (origin === 'website') {
    const counts = skipped.counts || part?.coverage
    if (counts) coverageWarnings.push(`${counts.indexed ?? count ?? 0}/${counts.discovered ?? count ?? 0} discovered page(s) indexed.`)
    if (skipped.javascriptRequired?.length || skipped.jsRendered?.length) warn(`${(skipped.javascriptRequired || skipped.jsRendered).length} route(s) still require JavaScript rendering.`)
    if (skipped.failed?.length || skipped.notFetched?.length) warn(`${(skipped.failed || skipped.notFetched).length} page(s) failed to fetch or extract.`)
    if (skipped.authRequired?.length) warn(`${skipped.authRequired.length} page(s) require authentication.`)
    if (skipped.blocked?.length) warn(`${skipped.blocked.length} URL(s) were blocked by robots rules or network safety checks.`)
    if (skipped.duplicates?.length) coverageWarnings.push(`${skipped.duplicates.length} duplicate-content page(s) were not indexed twice.`)
    if (skipped.overPageLimit?.length) warn(`Crawl limit reached with ${skipped.overPageLimit.length} URL(s) remaining.`)
    if (skipped.browser?.warning && skipped.javascriptRequired?.length) warn(skipped.browser.warning)
    if (skipped.syncWarning) warn(`${skipped.syncWarning.reason} The previous indexed website snapshot remains in use.`)
  } else {
    const coverage = part?.coverage || {}
    if (coverage.discovered !== undefined) coverageWarnings.push(`${coverage.indexed ?? count ?? 0}/${coverage.discovered} discovered file(s) indexed.`)
    if (skipped.tooLarge?.length) warn(`${skipped.tooLarge.length} file(s) exceeded the per-file size limit.`)
    if (skipped.overFileLimit?.length) warn(`${skipped.overFileLimit.length} file(s) were beyond the indexing limit.`)
    if (skipped.failed?.length) warn(`${skipped.failed.length} file(s) failed to fetch.`)
    if (skipped.binary?.length) warn(`${skipped.binary.length} binary file(s) were excluded.`)
    if (skipped.truncatedTree) warn('GitHub truncated the repository file listing; some files may be missing.')
    if (skipped.syncWarning) warn(`${skipped.syncWarning.reason} The previous indexed commit remains in use.`)
    if (skipped.redactedFileCount) warn(`Secrets were redacted from ${skipped.redactedFileCount} file(s) before indexing.`)
  }
  const state: StepState = running ? 'active' : failed ? 'failed' : part && hasWarnings ? 'warning' : part ? 'done' : 'todo'
  const label = origin === 'website'
    ? part && `${count ?? ''} page${count === 1 ? '' : 's'} from ${String(part.repository?.url || 'the site').replace(/^https?:\/\//, '').replace(/\/$/, '')}`
    : part && `${count ?? ''} files ${part.repository?.fullName ? `from ${part.repository.fullName}` : 'uploaded'}`
  const progress = job?.progress?.total ? ` ${job.progress.fetched}/${job.progress.total}` : ''
  return { part, job, running, failed, state, label, progress, coverageWarning: coverageWarnings.join(' '), hasWarnings }
}

function SetupGuide({ id, data, go }: { id: string; data: any; go: (t: Tab) => void }) {
  const storageKey = `ctx_setup_hidden_${id}`
  const [hidden, setHidden] = useState(() => localStorage.getItem(storageKey) === '1')
  const code = sourceStatus(data, 'code')
  const site = sourceStatus(data, 'website')
  if (hidden || (code.part && site.part)) return null

  const link = (t: Tab, label: string) => <Button variant="ghost" className="!px-3 !py-1.5 text-xs" onClick={() => go(t)}>{label}</Button>
  const detail = (s: ReturnType<typeof sourceStatus>, todo: string, noun: string) =>
    s.running ? `${s.job.kind === 'website-crawl' ? 'Crawling' : 'Indexing'}${s.progress}… you can keep going while this runs.`
      : s.failed ? `${s.job.error}${s.part ? ` The previous ${noun} index is still in use.` : ''}`
        : s.part ? `${s.label}.${s.coverageWarning ? ` ${s.coverageWarning}` : ''}` : todo

  return (
    <Reveal>
      <div className="card mb-6 p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-base font-semibold text-white">Setup</div>
          </div>
          <button onClick={() => { localStorage.setItem(storageKey, '1'); setHidden(true) }} className="text-xs text-zinc-500 hover:text-butter">Hide</button>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Step n={1} state={code.state} title="Code" detail={detail(code, 'Connect a GitHub repository or upload a folder.', 'code')} action={!code.running && (!code.part || code.failed) ? link('understand', code.failed ? 'Retry' : 'Connect') : undefined} />
          <Step n={2} state={site.state} title="Website" detail={detail(site, 'Add a website to index its pages.', 'website')} action={!site.running && (!site.part || site.failed) ? link('understand', site.failed ? 'Retry' : 'Connect') : undefined} />
          <Step n={3} state="todo" title="Try it" detail="Ask a question or embed the widget." action={<div className="flex flex-wrap gap-2">{link('ask', 'Ask')}{link('integrate', 'Embed')}</div>} />
        </div>
      </div>
    </Reveal>
  )
}

function Understand({ id, data, reload }: { id: string; data: any; reload: () => void }) {
  const [repo, setRepo] = useState(data.project.repository?.url || '')
  const [branch, setBranch] = useState('')
  const [site, setSite] = useState(data.project.websiteUrl || '')
  const [statusUrl, setStatusUrl] = useState(data.project.statusUrl || '')
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any>(null)
  const a = data.profile?.architecture
  const sources: [Origin, string][] = [['code', 'Code'], ['website', 'Live website']]

  const connect = async () => {
    setError(null)
    try { await api.connectGithub(id, { repositoryUrl: repo, branch: branch || undefined }); reload() } catch (e: any) { setError(e.message) }
  }
  const saveStatusUrl = async () => {
    setError(null)
    try { await api.updateProject(id, { statusUrl: statusUrl.trim() || '' }); reload() } catch (e: any) { setError(e.message) }
  }
  const upload = async (list: FileList | null) => {
    if (!list?.length) return
    setError(null)
    try {
      const { files } = await readFolder(list)
      if (!files.length) throw new Error('No code, docs or config files found in that folder')
      await api.uploadFiles(id, files)
      reload()
    } catch (e: any) { setError(e.message) }
  }

  return (
    <div className="space-y-4">
      <Reveal>
        <div className="card grid gap-6 p-6 lg:grid-cols-[1.4fr_1fr]">
          <div>
            <div className="text-base font-semibold text-white">Connect a GitHub repository</div>
            <p className="mt-1 text-sm text-zinc-500">Public repositories work immediately; set GITHUB_TOKEN on the server for private ones. Indexing runs in the background.</p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <input className="input flex-1" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/owner/repo" />
              <input className="input sm:w-32" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="branch" />
              <Button onClick={connect} disabled={!repo}>Index</Button>
            </div>
          </div>
          <div>
            <div className="text-base font-semibold text-white">Or upload source & docs</div>
            <p className="mt-1 text-sm text-zinc-500">Select a project folder; only code, docs and config files are indexed.</p>
            <label className="mt-4 flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-white/[0.1] px-4 py-3 text-sm text-zinc-400 transition hover:border-violet-500/40 hover:text-zinc-200">
              Choose folder
              <input type="file" className="hidden" multiple {...({ webkitdirectory: '' } as any)} onChange={(e) => upload(e.target.files)} />
            </label>
          </div>
          <div className="lg:col-span-2">
            <div className="text-base font-semibold text-white">Index live website content</div>
            <p className="mt-1 text-sm text-zinc-500">Discovers same-origin pages through links, robots.txt and sitemaps. Chromium rendering is used when Playwright is installed; forms are inspected but never submitted. Re-crawling only replaces website knowledge.</p>
            <div className="mt-4 flex gap-2">
              <input className="input flex-1" value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://www.example.com" />
              <Button variant="ghost" disabled={!site} onClick={async () => { setError(null); try { await api.connectWebsite(id, site); reload() } catch (e: any) { setError(e.message) } }}>Crawl</Button>
            </div>
          </div>
          <div className="lg:col-span-2">
            <details className="rounded-xl border border-white/[0.05] bg-black/20 px-4 py-3" open={!!data.project.statusUrl}>
              <summary className="cursor-pointer text-sm font-medium text-zinc-300">Optional: configure live service health checks</summary>
              <p className="mt-2 text-xs leading-relaxed text-zinc-500">Only needed if you want answers about whether the app or its backend is up. This endpoint is checked for health; it does not add or crawl another website. Leave it blank to use automatic health checks.</p>
              <div className="mt-3 flex gap-2">
                <input className="input flex-1" value={statusUrl} onChange={(e) => setStatusUrl(e.target.value)} placeholder="https://api.example.com/health" aria-label="Optional service health endpoint" />
                <Button variant="ghost" disabled={statusUrl.trim() === (data.project.statusUrl || '')} onClick={saveStatusUrl}>{statusUrl.trim() ? 'Save endpoint' : 'Remove endpoint'}</Button>
              </div>
            </details>
          </div>
          <div className="lg:col-span-2"><ErrorNote error={error} /></div>
          <div className="space-y-2 lg:col-span-2">
            {sources.map(([origin, label]) => {
              const s = sourceStatus(data, origin)
              return (
                <div key={origin} className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.05] bg-black/20 px-4 py-2.5 text-sm">
                  <span className="w-24 shrink-0 text-zinc-300">{label}</span>
                  <Badge tone={s.running ? 'amber' : s.failed ? 'red' : s.hasWarnings ? 'amber' : s.part ? 'green' : 'zinc'}>{s.running ? s.job.status : s.failed ? 'failed' : s.hasWarnings ? 'completed with warnings' : s.part ? 'indexed' : 'not connected'}</Badge>
                  {s.running && <span className="text-zinc-500">{s.job.repositoryUrl}{s.progress && ` ·${s.progress}`}</span>}
                  {!s.running && s.part && <span className="text-zinc-500">{s.label}</span>}
                  {!s.running && s.coverageWarning && <span className="basis-full text-xs text-amber-300">{s.coverageWarning}</span>}
                  {s.failed && <span className="text-red-300">{s.job.error}</span>}
                  {(s.job || s.part) && <span className="ml-auto text-xs text-zinc-600">{timeAgo(s.job?.createdAt || s.part?.indexedAt)}</span>}
                </div>
              )
            })}
          </div>
        </div>
      </Reveal>

      {!a ? <Empty title="Not indexed yet">Connect the code and the live website to build the project profile.</Empty> : (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[['Frontend', a.stack.frontend], ['Backend', a.stack.backend], ['Data', a.stack.data], ['Auth', a.stack.auth]].map(([label, items]: any, i) => (
              <Reveal key={label} delay={i * 60}>
                <div className="card h-full p-5">
                  <div className="eyebrow">{label}</div>
                  <div className="mt-3 flex flex-wrap gap-1.5">{items.length ? items.map((x: string) => <Badge key={x} tone="violet">{x}</Badge>) : <span className="text-sm text-zinc-600">Not detected</span>}</div>
                </div>
              </Reveal>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Reveal>
              <div className="card p-6">
                <div className="mb-3 flex items-center justify-between"><div className="eyebrow">Backend routes</div><span className="text-xs text-zinc-600">{a.routes.length}</span></div>
                <div className="max-h-80 space-y-1 overflow-auto font-mono text-[12px]">
                  {a.routes.map((r: any, i: number) => (
                    <div key={i} className="flex gap-3 rounded-md px-2 py-1 hover:bg-white/[0.03]">
                      <span className={`w-14 shrink-0 ${{ GET: 'text-sky-300', POST: 'text-emerald-300', DELETE: 'text-red-300' }[r.method as string] || 'text-amber-300'}`}>{r.method}</span>
                      <span className="flex-1 truncate text-zinc-200">{r.path}</span>
                      <span className="truncate text-zinc-600">{r.file}:{r.line}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>
            <Reveal delay={80}>
              <div className="card p-6">
                <div className="mb-3 flex items-center justify-between"><div className="eyebrow">Data models</div><span className="text-xs text-zinc-600">{a.models.length}</span></div>
                <div className="max-h-80 space-y-2 overflow-auto">
                  {a.models.map((m: any) => (
                    <div key={m.name} className="rounded-lg border border-white/[0.04] px-3 py-2">
                      <div className="flex justify-between text-sm"><span className="text-zinc-200">{m.name}</span><span className="font-mono text-[11px] text-zinc-600">{m.file}:{m.line}</span></div>
                      {m.fields?.length > 0 && <div className="mt-1 truncate text-xs text-zinc-500">{m.fields.join(', ')}</div>}
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>
          </div>
          {data.profile?.parts?.website?.architecture?.pages?.length > 0 && (
            <Reveal>
              <div className="card p-6">
                <div className="mb-3 flex items-center justify-between"><div className="eyebrow">Website page inventory</div><span className="text-xs text-zinc-600">{data.profile.parts.website.architecture.pages.length}</span></div>
                <div className="max-h-96 space-y-2 overflow-auto">
                  {data.profile.parts.website.architecture.pages.map((page: any) => (
                    <details key={page.url || page.file} className="rounded-lg border border-white/[0.05] bg-black/20 px-3 py-2">
                      <summary className="flex cursor-pointer items-center gap-3 text-sm">
                        <span className="min-w-0 flex-1 truncate text-zinc-200">{page.title || page.url || page.file}</span>
                        <Badge tone={page.extractionStatus === 'partial' ? 'amber' : 'green'}>{page.extractionStatus || 'extracted'}</Badge>
                      </summary>
                      {page.url && <a className="mt-2 block truncate font-mono text-[11px] text-sky-300 hover:underline" href={page.url} target="_blank" rel="noreferrer">{page.url}</a>}
                      {page.purpose && <p className="mt-2 text-xs leading-relaxed text-zinc-400">{page.purpose}</p>}
                      {page.features?.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{page.features.map((feature: any) => <Badge key={feature.name}>{feature.name}</Badge>)}</div>}
                    </details>
                  ))}
                </div>
              </div>
            </Reveal>
          )}
          <Reveal>
            <div className="card p-6">
              <div className="eyebrow mb-3">Search indexed knowledge</div>
              <form onSubmit={async (e) => { e.preventDefault(); setResults(await api.search(id, q)) }} className="flex gap-2">
                <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="payment verification, booking availability, auth middleware…" />
                <Button type="submit" variant="ghost" disabled={!q}>Search</Button>
              </form>
              {results && (
                <div className="mt-4 space-y-2">
                  {results.results.length === 0 && <div className="text-sm text-zinc-500">No matches.</div>}
                  {results.results.map((r: any, i: number) => (
                    <details key={i} className="rounded-xl border border-white/[0.05] bg-black/20 px-4 py-3">
                      <summary className="flex cursor-pointer items-center gap-3 text-sm"><span className="font-mono text-zinc-200">{r.source}{r.lines ? `:${r.lines}` : ''}</span><Badge>{r.type}</Badge><span className="ml-auto font-mono text-[11px] text-zinc-600">{r.score}</span></summary>
                      <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-zinc-400">{r.snippet}</pre>
                    </details>
                  ))}
                </div>
              )}
            </div>
          </Reveal>
        </>
      )}
    </div>
  )
}

export function DataTab({ id, integrations, reload }: { id: string; integrations: any[]; reload: () => void }) {
  const [type, setType] = useState('mongodb')
  const [name, setName] = useState('')
  const [conn, setConn] = useState('')
  const [database, setDatabase] = useState('')
  const [allowed, setAllowed] = useState('')
  const [json, setJson] = useState('')
  const [synthetic, setSynthetic] = useState(false)
  const [mode, setMode] = useState('rest')
  const [sources, setSources] = useState('')
  const [headers, setHeaders] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const add = async () => {
    setError(null)
    setLoading(true)
    try {
      const allowedCollections = allowed.split(',').map((s) => s.trim()).filter(Boolean)
      const body: any = { type, name: name || `${type} source`, allowedCollections }
      if (type === 'dataset') { body.collections = JSON.parse(json); body.synthetic = synthetic }
      else if (type === 'http') body.config = { mode, sources: JSON.parse(sources), ...(headers.trim() ? { headers: JSON.parse(headers) } : {}) }
      else body.config = { connectionString: conn, ...(database ? { database } : {}) }
      const r = await api.addIntegration(id, body)
      if (!r.health.ok) setError(`Saved, but the connection test failed: ${r.health.error}`)
      setConn(''); setJson(''); setName('')
      reload()
    } catch (e: any) { setError(e instanceof SyntaxError ? 'Invalid JSON in one of the fields' : e.message) } finally { setLoading(false) }
  }
  const sourceExample: Record<string, string> = {
    rest: '[{ "name": "orders", "url": "https://xyz.supabase.co/rest/v1/orders?select=*" }]',
    graphql: '[{ "name": "orders", "url": "https://api.example.com/graphql", "query": "{ orders { id status total } }", "path": "data.orders" }]',
    csv: '[{ "name": "sales", "url": "https://docs.google.com/spreadsheets/d/…/export?format=csv" }]',
    firestore: '[{ "name": "orders", "url": "https://firestore.googleapis.com/v1/projects/ID/databases/(default)/documents/orders?key=API_KEY" }]',
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.3fr]">
      <Reveal>
        <div className="card space-y-4 p-6">
          <div className="text-base font-semibold text-white">Add a data source</div>
          <div className="grid grid-cols-3 gap-1 rounded-xl border border-white/[0.06] p-1 sm:grid-cols-5">
            {[['mongodb', 'MongoDB'], ['postgresql', 'PostgreSQL'], ['mysql', 'MySQL'], ['http', 'API / Sheets'], ['dataset', 'JSON']].map(([v, l]) => (
              <button key={v} onClick={() => setType(v)} aria-pressed={type === v} className={`rounded-lg py-1.5 text-sm transition ${type === v ? 'bg-butter text-ink-950' : 'text-zinc-500 hover:text-butter'}`}>{l}</button>
            ))}
          </div>
          <div><label className="label">Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Production read replica" /></div>
          {type === 'http' ? (
            <>
              <div><label className="label">Source type</label>
                <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="rest">REST JSON — Supabase, Firebase Realtime DB, any API</option>
                  <option value="graphql">GraphQL (read-only query)</option>
                  <option value="csv">CSV — Google Sheets, exports</option>
                  <option value="firestore">Firestore REST</option>
                </select>
              </div>
              <div><label className="label">Collections (name → URL)</label><textarea className="input h-28 font-mono text-xs" value={sources} onChange={(e) => setSources(e.target.value)} placeholder={sourceExample[mode]} /></div>
              <div><label className="label">Headers (optional, encrypted)</label><input className="input font-mono text-xs" value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder='{ "apikey": "…", "Authorization": "Bearer …" }' /></div>
            </>
          ) : type === 'dataset' ? (
            <>
              <div><label className="label">Records</label><textarea className="input h-40 font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} placeholder='{ "orders": [ { "status": "cancelled", "amount": 120 } ] }' /></div>
              <label className="flex items-center gap-2 text-sm text-zinc-400"><input type="checkbox" checked={synthetic} onChange={(e) => setSynthetic(e.target.checked)} className="accent-violet-500" /> This is synthetic test data (answers will say so)</label>
            </>
          ) : (
            <>
              <div><label className="label">Connection string (encrypted on the server)</label><input className="input font-mono text-xs" type="password" value={conn} onChange={(e) => setConn(e.target.value)} placeholder={{ mongodb: 'mongodb+srv://readonly:…@cluster/db', postgresql: 'postgresql://readonly:…@host:5432/db (Supabase, Neon, RDS…)', mysql: 'mysql://readonly:…@host:3306/db (PlanetScale, MariaDB…)' }[type]} /></div>
              {type === 'mongodb' && <div><label className="label">Database</label><input className="input" value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="defaults to the one in the URI" /></div>}
              <p className="text-xs leading-relaxed text-zinc-500">Use a read-only database user. ContextAI only issues find / count / grouped aggregate queries{type !== 'mongodb' ? ' inside READ ONLY transactions' : ''}.</p>
            </>
          )}
          <div><label className="label">Allowed collections / tables (comma separated, empty = all)</label><input className="input" value={allowed} onChange={(e) => setAllowed(e.target.value)} placeholder="orders, products, customers" /></div>
          <ErrorNote error={error} />
          <Button onClick={add} loading={loading} className="w-full">Connect & test</Button>
        </div>
      </Reveal>

      <div className="space-y-3">
        {integrations.length === 0 && <Empty title="No data connected">Without data the engine can still answer code questions, but will say plainly that live data was not checked.</Empty>}
        {integrations.map((it, i) => (
          <Reveal key={it.id} delay={i * 60}>
            <div className="card p-5">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-[15px] font-medium text-white">{it.name}</div>
                <Badge>{it.type}</Badge>
                {it.synthetic && <Badge tone="amber">synthetic</Badge>}
                <Badge tone={statusTone(it.status)}>{it.status}</Badge>
                <div className="ml-auto flex gap-1.5">
                  <Button variant="ghost" className="!px-3 !py-1.5 text-xs" onClick={async () => { await api.testIntegration(id, it.id); reload() }}>Test</Button>
                  <Button variant="ghost" className="!px-3 !py-1.5 text-xs" onClick={async () => { await api.refreshSchema(id, it.id).catch(() => {}); reload() }}>Refresh schema</Button>
                  <Button variant="danger" className="!px-3 !py-1.5 text-xs" onClick={async () => { if (confirm(`Remove ${it.name}?`)) { await api.deleteIntegration(id, it.id); reload() } }}>Remove</Button>
                </div>
              </div>
              {it.health?.error && <div className="mt-2 text-sm text-red-300">{it.health.error}</div>}
              {it.schema && (
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {Object.entries(it.schema).map(([coll, info]: any) => (
                    <div key={coll} className="rounded-lg border border-white/[0.04] bg-black/20 px-3 py-2">
                      <div className="flex justify-between text-sm"><span className="font-mono text-zinc-200">{coll}</span><span className="text-xs text-zinc-600">{info.count ?? '?'} rows</span></div>
                      <div className="mt-1 text-xs leading-relaxed text-zinc-500">{info.fields.map((f: any) => `${f.name}:${f.type}`).join('  ')}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3 text-xs text-zinc-600">Allowed: {it.allowedCollections?.join(', ') || 'all discovered collections'} · checked {timeAgo(it.lastCheckedAt)}</div>
            </div>
          </Reveal>
        ))}
      </div>
    </div>
  )
}

export function Definitions({ id, definitions, integrations, reload }: { id: string; definitions: any[]; integrations: any[]; reload: () => void }) {
  const empty = { term: '', meaning: '', collection: '', field: '', value: '', metricField: '', formula: '', whereField: '', whereOp: 'eq', whereValue: '' }
  const [f, setF] = useState(empty)
  const [error, setError] = useState<string | null>(null)
  const collections = integrations.flatMap((i) => Object.keys(i.schema || {}))
  const fields = integrations.flatMap((i) => i.schema?.[f.collection]?.fields || []).map((x: any) => x.name)
  const parse = (v: string) => (v === '' ? undefined : !isNaN(Number(v)) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v)

  const save = async () => {
    setError(null)
    const body: any = { term: f.term, meaning: f.meaning }
    for (const k of ['collection', 'field', 'metricField', 'formula'] as const) if (f[k]) body[k] = f[k]
    if (f.value !== '') body.value = parse(f.value)
    if (f.whereField) body.where = [{ field: f.whereField, op: f.whereOp, value: parse(f.whereValue) }]
    try { await api.addDefinition(id, body); setF(empty); reload() } catch (e: any) { setError(e.message) }
  }
  const set = (k: keyof typeof empty) => (e: any) => setF({ ...f, [k]: e.target.value })

  return (
    <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
      <Reveal>
        <div className="card space-y-4 p-6">
          <div>
            <div className="text-base font-semibold text-white">Confirm a business definition</div>
            <p className="mt-1 text-sm text-zinc-500">Field names rarely carry full meaning. Definitions are developer-confirmed and take priority over anything the engine infers.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className="label">Term (as people ask it)</label><input className="input" value={f.term} onChange={set('term')} placeholder="payment service" /></div>
            <div><label className="label">Collection</label><select className="input" value={f.collection} onChange={set('collection')}><option value="">Any</option>{collections.map((c) => <option key={c}>{c}</option>)}</select></div>
          </div>
          <div><label className="label">Meaning</label><input className="input" value={f.meaning} onChange={set('meaning')} placeholder="The gateway that processed the transaction" /></div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div><label className="label">Maps to field</label><select className="input" value={f.field} onChange={set('field')}><option value="">—</option>{fields.map((x: string) => <option key={x}>{x}</option>)}</select></div>
            <div><label className="label">…with value</label><input className="input" value={f.value} onChange={set('value')} placeholder="failed" /></div>
            <div><label className="label">Metric field</label><select className="input" value={f.metricField} onChange={set('metricField')}><option value="">—</option>{fields.map((x: string) => <option key={x}>{x}</option>)}</select></div>
          </div>
          <div><label className="label">Formula (numeric fields, + − × ÷)</label><input className="input font-mono text-xs" value={f.formula} onChange={set('formula')} placeholder="(price - cost) * unitsSold" /></div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div><label className="label">Filter field</label><select className="input" value={f.whereField} onChange={set('whereField')}><option value="">—</option>{fields.map((x: string) => <option key={x}>{x}</option>)}</select></div>
            <div><label className="label">Operator</label><select className="input" value={f.whereOp} onChange={set('whereOp')}>{['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'isnull', 'notnull'].map((o) => <option key={o}>{o}</option>)}</select></div>
            <div><label className="label">Value</label><input className="input" value={f.whereValue} onChange={set('whereValue')} placeholder="0" /></div>
          </div>
          <ErrorNote error={error} />
          <Button onClick={save} disabled={!f.term || !f.meaning} className="w-full">Save definition</Button>
        </div>
      </Reveal>
      <div className="space-y-3">
        {definitions.length === 0 && <Empty title="No definitions yet">Examples: “failure” = transactions.status is failed · “unavailable” = products where stock ≤ 0 · “profit” = (price − cost) × unitsSold.</Empty>}
        {definitions.map((d, i) => (
          <Reveal key={d.id} delay={i * 50}>
            <div className="card flex items-start gap-4 p-5">
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-medium text-white">“{d.term}”</div>
                <div className="mt-0.5 text-sm text-zinc-400">{d.meaning}</div>
                <div className="mt-2 font-mono text-[11px] text-zinc-500">
                  {[d.collection, d.field && `${d.field}${d.value !== undefined ? ` = ${JSON.stringify(d.value)}` : ''}`, d.metricField && `metric ${d.metricField}`, d.formula, d.where?.map((w: any) => `${w.field} ${w.op} ${w.value ?? ''}`).join(' and ')].filter(Boolean).join(' · ')}
                </div>
              </div>
              <button onClick={async () => { await api.deleteDefinition(id, d.id); reload() }} className="text-xs text-zinc-600 hover:text-red-300">Remove</button>
            </div>
          </Reveal>
        ))}
      </div>
    </div>
  )
}

function Approvals({ id }: { id: string }) {
  const [actions, setActions] = useState<any[]>([])
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => api.actions(id).then((d) => setActions(d.actions)), [id])
  useEffect(() => { load() }, [load])
  const decide = async (actionId: string, decision: 'approve' | 'reject') => {
    setError(null)
    try { await api.decideAction(id, actionId, decision) } catch (e: any) { setError(e.message) }
    load()
  }
  return (
    <Reveal>
      <div className="card p-6">
        <div className="eyebrow mb-1">Action approvals</div>
        <p className="mb-4 text-sm text-zinc-500">Data-changing tools never run on their own. Each request waits here until you approve it, then runs once through your app’s API.</p>
        <ErrorNote error={error} />
        {actions.length === 0 ? <div className="text-sm text-zinc-600">No action requests yet.</div> : (
          <div className="space-y-2">
            {actions.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.05] bg-black/20 px-4 py-3 text-sm">
                <span className="font-mono text-xs text-violet-300">{a.method}</span>
                <span className="text-zinc-200">{a.toolName}</span>
                <span className="truncate font-mono text-xs text-zinc-500">{JSON.stringify(a.params)}</span>
                {a.reason && <span className="text-xs text-zinc-500">“{a.reason}”</span>}
                <span className="ml-auto flex items-center gap-2">
                  <Badge tone={a.status === 'executed' ? 'green' : a.status === 'pending' ? 'amber' : a.status === 'rejected' ? 'zinc' : 'red'}>{a.status}</Badge>
                  {a.status === 'pending' && <>
                    <Button className="!px-3 !py-1.5 text-xs" onClick={() => decide(a.id, 'approve')}>Approve & run</Button>
                    <Button variant="ghost" className="!px-3 !py-1.5 text-xs" onClick={() => decide(a.id, 'reject')}>Reject</Button>
                  </>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Reveal>
  )
}

function Integrate({ id, data, reload }: { id: string; data: any; reload: () => void }) {
  const [secret, setSecret] = useState<any>(null)
  const [tool, setTool] = useState({ name: '', description: '', url: '', method: 'GET', parameters: '' })
  const [error, setError] = useState<string | null>(null)
  const pk = data.apiKeys.find((k: any) => !k.revokedAt)?.publicKey || 'pk_…'

  return (
    <div className="space-y-4">
      <Reveal>
        <div className="card p-6">
          <div className="text-base font-semibold text-white">Use this project from any app</div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div><div className="label">Browser / frontend (public key: ask & search only)</div><Code>{`npm install @contextai/sdk

import { ContextAI } from "@contextai/sdk";

const ai = new ContextAI({
  baseUrl: "${apiBase}",
  projectId: "${id}",
  publicKey: "${pk}",
});

const result = await ai.ask({ question: "Why are orders being cancelled?" });
console.log(result.answer, result.evidence, result.limitations);`}</Code></div>
            <div><div className="label">Any backend (REST, secret key)</div><Code>{`curl -X POST ${apiBase}/api/v1/projects/${id}/ask \\
  -H "Content-Type: application/json" \\
  -H "X-Secret-Key: sk_…" \\
  -d '{"question":"Which payment service has the highest failure rate?"}'`}</Code></div>
          </div>
        </div>
      </Reveal>

      <Reveal>
        <div className="card space-y-3 p-6">
          <div className="text-base font-semibold text-white">Embed a chat assistant</div>
          <p className="text-sm leading-relaxed text-zinc-500">Install the SDK in your website and add the ContextAI custom element. The floating chat panel includes quick prompts for the configured live status check. Use only the public key in browser code.</p>
          <Code>{`npm install @contextai/sdk\n\n// Import once in your frontend entry point\nimport "@contextai/sdk/widget";`}</Code>
          <Code>{`<contextai-widget\n  base-url="${apiBase}"\n  project-id="${id}"\n  public-key="${pk}"\n  title="Ask about ${data.project.name}"\n></contextai-widget>`}</Code>
          <p className="text-xs text-zinc-500">If your API restricts cross-origin calls, add the website's origin to <code className="font-mono text-zinc-300">CORS_ORIGINS</code>. Never put a secret key or user-token signing secret in the page.</p>
        </div>
      </Reveal>

      <div className="grid gap-4 lg:grid-cols-2">
        <Reveal>
          <div className="card p-6">
            <div className="mb-4 flex items-center justify-between"><div className="eyebrow">API keys</div><Button variant="ghost" className="!py-1.5 text-xs" onClick={async () => { setSecret(await api.createKey(id)); reload() }}>New key pair</Button></div>
            {secret && <div className="mb-4 space-y-2"><div className="text-sm text-emerald-300">Copy the secret now — it is not stored in readable form.</div><Code>{`publicKey: ${secret.publicKey}\nsecretKey: ${secret.secretKey}`}</Code></div>}
            <div className="space-y-2">
              {data.apiKeys.map((k: any) => (
                <div key={k.id} className="flex items-center gap-3 rounded-lg border border-white/[0.04] px-3 py-2 text-sm">
                  <span className="truncate font-mono text-xs text-zinc-300">{k.publicKey}</span>
                  {k.revokedAt ? <Badge tone="red">revoked</Badge> : <button onClick={async () => { if (confirm('Revoke this key pair?')) { await api.revokeKey(id, k.id); reload() } }} className="ml-auto text-xs text-zinc-600 hover:text-red-300">Revoke</button>}
                </div>
              ))}
            </div>
          </div>
        </Reveal>
        <Reveal delay={80}>
          <div className="card space-y-3 p-6">
            <div className="eyebrow">Registered API tools</div>
            <p className="text-sm text-zinc-500">GET tools may be called during investigations. POST / PUT / PATCH / DELETE tools change data and only run after approval. Use <span className="font-mono">{'{param}'}</span> in the URL for path values.</p>
            <div className="grid gap-2 sm:grid-cols-[110px_1fr]">
              <select className="input" value={tool.method} onChange={(e) => setTool({ ...tool, method: e.target.value })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}</select>
              <input className="input" value={tool.url} onChange={(e) => setTool({ ...tool, url: e.target.value })} placeholder="https://app.example.com/api/orders/{orderId}/refund" />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <input className="input" value={tool.name} onChange={(e) => setTool({ ...tool, name: e.target.value })} placeholder="refund_order" />
              <input className="input" value={tool.parameters} onChange={(e) => setTool({ ...tool, parameters: e.target.value })} placeholder="extra params: amount, reason" />
            </div>
            <input className="input" value={tool.description} onChange={(e) => setTool({ ...tool, description: e.target.value })} placeholder="Refund an order to the customer" />
            <ErrorNote error={error} />
            <Button variant="ghost" className="w-full" disabled={!tool.name || !tool.url} onClick={async () => { setError(null); try { await api.addTool(id, { ...tool, parameters: tool.parameters.split(',').map((s) => s.trim()).filter(Boolean) }); setTool({ name: '', description: '', url: '', method: 'GET', parameters: '' }); reload() } catch (e: any) { setError(e.message) } }}>Register tool</Button>
            {data.tools.map((t: any) => (
              <div key={t.id} className="flex items-center gap-3 rounded-lg border border-white/[0.04] px-3 py-2 text-sm">
                <span className={`font-mono text-[11px] ${t.method === 'GET' ? 'text-sky-300' : 'text-amber-300'}`}>{t.method || 'GET'}</span>
                <span className="font-mono text-xs text-zinc-200">{t.name}</span><span className="truncate text-xs text-zinc-500">{t.url}</span>
                <button onClick={async () => { await api.deleteTool(id, t.id); reload() }} className="ml-auto text-xs text-zinc-600 hover:text-red-300">Remove</button>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
      <Approvals id={id} />
    </div>
  )
}
