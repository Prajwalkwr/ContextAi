import { FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { FolderSelection, detectSource, readFolder } from '../lib/connect'
import { Badge, Button, Empty, ErrorNote, PageHeader, Reveal, statusTone, timeAgo } from '../components/ui'

export default function Projects() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<any[] | null>(null)
  const [codeInput, setCodeInput] = useState('')
  const [siteInput, setSiteInput] = useState('')
  const [folder, setFolder] = useState<FolderSelection | null>(null)
  const [reading, setReading] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [branch, setBranch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => { api.projects().then((d) => setProjects(d.projects)).catch((e) => setError(e.message)) }, [])

  const codeGuess = folder ? null : detectSource(codeInput)
  const siteGuess = detectSource(siteInput)
  const repo = codeGuess?.kind === 'github' ? codeGuess : siteGuess?.kind === 'github' && !codeInput.trim() && !folder ? siteGuess : null
  const site = siteGuess?.kind === 'website' ? siteGuess : codeGuess?.kind === 'website' && !siteInput.trim() ? codeGuess : null
  const derivedName = repo?.name || folder?.folder || site?.name || ''
  const finalName = name.trim() || derivedName
  const codeInvalid = !folder && codeInput.trim() !== '' && !codeGuess
  const siteInvalid = siteInput.trim() !== '' && !siteGuess
  const misplaced = (codeGuess?.kind === 'website' && site !== codeGuess) || (siteGuess?.kind === 'github' && repo !== siteGuess)
  const invalidInput = codeInvalid || siteInvalid || misplaced

  const pickFolder = async (list: FileList | null) => {
    if (!list?.length) return
    setError(null)
    setReading(true)
    try {
      const sel = await readFolder(list)
      if (!sel.files.length) throw new Error('No code, docs or config files found in that folder')
      setFolder(sel)
      setCodeInput('')
    } catch (e: any) { setError(e.message) } finally { setReading(false) }
  }

  const create = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const body: any = { name: finalName, description }
      if (repo) Object.assign(body, { repositoryUrl: repo.url, ...(branch.trim() ? { branch: branch.trim() } : {}) })
      if (site) body.websiteUrl = site.url
      const created = await api.createProject(body)
      const id = created.project.id
      let connectError: string | null = null
      if (folder) await api.uploadFiles(id, folder.files).catch((err: any) => { connectError = err.message })
      navigate(`/projects/${id}`, { state: { credentials: created.credentials, connectError } })
    } catch (err: any) { setError(err.message); setLoading(false) }
  }

  const connecting = !!(repo || site || folder)
  const hint = (text: string, tone: 'ok' | 'warn' | 'muted') => <div className={`mt-1.5 text-xs ${{ ok: 'text-emerald-300', warn: 'text-amber-300', muted: 'text-zinc-600' }[tone]}`}>{text}</div>

  return (
    <>
      <PageHeader title="Projects" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <Reveal>
          <form onSubmit={create} className="card space-y-4 p-6">
            <div>
              <div className="text-base font-semibold text-white">Connect a project</div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="label !mb-0">Code</label>
                {!folder && (
                  <label className={`cursor-pointer text-xs text-zinc-500 transition hover:text-butter ${reading ? 'pointer-events-none opacity-50' : ''}`}>
                    {reading ? 'Reading folder…' : 'or upload a folder'}
                    <input type="file" className="hidden" multiple {...({ webkitdirectory: '' } as any)} onChange={(e) => { pickFolder(e.target.files); e.target.value = '' }} />
                  </label>
                )}
              </div>
              {folder ? (
                <div className="flex items-center gap-3 rounded-xl border border-butter/30 bg-butter/[0.06] px-3.5 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-zinc-100">{folder.folder || 'Selected folder'}</div>
                    <div className="text-xs text-zinc-500">{folder.files.length} files ready{folder.skipped ? ` · ${folder.skipped} skipped (dependencies, builds, binaries)` : ''}</div>
                  </div>
                  <button type="button" onClick={() => setFolder(null)} className="text-xs text-zinc-500 hover:text-butter">Remove</button>
                </div>
              ) : (
                <>
                  <input className="input" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} placeholder="github.com/owner/repo" autoFocus />
                  {codeGuess?.kind === 'website' && hint('Use the Live website field for a website URL.', 'warn')}
                  {codeInvalid && hint('Enter a GitHub URL or owner/repo.', 'warn')}
                </>
              )}
            </div>

            <div>
              <label className="label">Live website</label>
              <input className="input" value={siteInput} onChange={(e) => setSiteInput(e.target.value)} placeholder="https://yourapp.com" />
              {siteGuess?.kind === 'github' && hint('Use the Code field for a GitHub repository.', 'warn')}
              {siteInvalid && hint('Enter a valid website URL.', 'warn')}
            </div>

            <div>
              <label className="label">Project name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={derivedName || 'UdyogConnect'} maxLength={80} />
            </div>

            <details className="group">
              <summary className="cursor-pointer select-none text-xs text-zinc-500 hover:text-zinc-300">More options</summary>
              <div className="mt-3 space-y-3">
                <div><label className="label">Description</label><textarea className="input h-20 resize-none" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this app do?" /></div>
                {repo && <div><label className="label">Branch</label><input className="input" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="default branch" /></div>}
              </div>
            </details>

            <ErrorNote error={error} />
            <Button type="submit" loading={loading} disabled={finalName.length < 2 || invalidInput || reading} className="w-full">
              {connecting ? 'Create & connect' : 'Create empty project'}
            </Button>
          </form>
        </Reveal>

        <div className="space-y-3">
          {projects === null && [0, 1, 2].map((i) => <div key={i} className="skeleton h-24" />)}
          {projects?.length === 0 && <Empty title="No projects yet">Your projects will appear here.</Empty>}
          {projects?.map((p, i) => (
            <Reveal key={p.id} delay={i * 60}>
              <Link to={`/projects/${p.id}`} className="card card-hover flex items-center gap-5 p-5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/20 to-sky-500/10 text-base font-semibold text-violet-200">{p.name[0]?.toUpperCase()}</div>
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-medium text-white">{p.name}</div>
                  <div className="truncate text-sm text-zinc-500">{p.description || p.repository?.fullName || 'No description'}</div>
                  <div className="mt-1 text-xs text-zinc-500">{p.repository?.fullName || p.websiteUrl || `Updated ${timeAgo(p.updatedAt || p.lastIndexedAt)}`}</div>
                </div>
                <Badge tone={statusTone(p.indexingStatus)}>{p.indexingStatus?.replace('_', ' ')}</Badge>
              </Link>
            </Reveal>
          ))}
        </div>
      </div>
    </>
  )
}
