const BASE = import.meta.env.VITE_API_URL || ''

export const session = {
  get token() { return localStorage.getItem('ctx_token') },
  get user() { const u = localStorage.getItem('ctx_user'); return u ? JSON.parse(u) : null },
  save(data: { token: string; refreshToken: string; user: unknown }) {
    localStorage.setItem('ctx_token', data.token)
    localStorage.setItem('ctx_refresh', data.refreshToken)
    localStorage.setItem('ctx_user', JSON.stringify(data.user))
    window.dispatchEvent(new Event('ctx-auth'))
  },
  clear() {
    for (const k of ['ctx_token', 'ctx_refresh', 'ctx_user']) localStorage.removeItem(k)
    window.dispatchEvent(new Event('ctx-auth'))
  },
}

async function refresh() {
  const refreshToken = localStorage.getItem('ctx_refresh')
  if (!refreshToken) return false
  const res = await fetch(`${BASE}/api/v1/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) })
  if (!res.ok) return false
  session.save(await res.json())
  return true
}

async function req<T = any>(path: string, opts: RequestInit = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (session.token) headers.Authorization = `Bearer ${session.token}`
  const res = await fetch(`${BASE}/api/v1${path}`, { ...opts, headers })
  if (res.status === 401 && retry && session.token) {
    if (await refresh()) return req<T>(path, opts, false)
    session.clear()
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.details?.join('; ') || data.error || `Request failed (${res.status})`)
  return data as T
}

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })
const p = (id: string) => `/projects/${id}`

export const api = {
  register: (email: string, password: string, name?: string) => req('/auth/register', post({ email, password, name })),
  login: (email: string, password: string) => req('/auth/login', post({ email, password })),
  overview: () => req('/projects/overview'),
  logs: (projectId?: string) => req(`/projects/logs${projectId ? `?projectId=${projectId}` : ''}`),
  projects: () => req('/projects'),
  createProject: (body: unknown) => req('/projects', post(body)),
  project: (id: string) => req(p(id)),
  updateProject: (id: string, body: unknown) => req(p(id), { method: 'PATCH', body: JSON.stringify(body) }),
  deleteProject: (id: string) => req(p(id), { method: 'DELETE' }),
  connectGithub: (id: string, body: unknown) => req(`${p(id)}/connect/github`, post(body)),
  uploadFiles: (id: string, files: { path: string; content: string }[]) => req(`${p(id)}/knowledge/index`, post({ files })),
  search: (id: string, q: string) => req(`${p(id)}/knowledge/search?q=${encodeURIComponent(q)}`),
  jobs: (id: string) => req(`${p(id)}/jobs`),
  addIntegration: (id: string, body: unknown) => req(`${p(id)}/integrations`, post(body)),
  testIntegration: (id: string, intId: string) => req(`${p(id)}/integrations/${intId}/test`, post({})),
  refreshSchema: (id: string, intId: string) => req(`${p(id)}/integrations/${intId}/schema`, post({})),
  deleteIntegration: (id: string, intId: string) => req(`${p(id)}/integrations/${intId}`, { method: 'DELETE' }),
  addDefinition: (id: string, body: unknown) => req(`${p(id)}/definitions`, post(body)),
  deleteDefinition: (id: string, defId: string) => req(`${p(id)}/definitions/${defId}`, { method: 'DELETE' }),
  addTool: (id: string, body: unknown) => req(`${p(id)}/tools`, post(body)),
  deleteTool: (id: string, toolId: string) => req(`${p(id)}/tools/${toolId}`, { method: 'DELETE' }),
  connectWebsite: (id: string, url: string) => req(`${p(id)}/connect/website`, post({ url })),
  actions: (id: string) => req(`${p(id)}/actions`),
  requestAction: (id: string, body: unknown) => req(`${p(id)}/actions`, post(body)),
  decideAction: (id: string, actionId: string, decision: 'approve' | 'reject') => req(`${p(id)}/actions/${actionId}/${decision}`, post({})),
  createKey: (id: string) => req(`${p(id)}/keys`, post({ label: 'dashboard' })),
  revokeKey: (id: string, keyId: string) => req(`${p(id)}/keys/${keyId}`, { method: 'DELETE' }),
  ask: (id: string, question: string, timeRange?: { from: string; to: string }, conversationId?: string) => req(`${p(id)}/ask`, post({ question, timeRange, conversationId })),
  assistant: (id: string) => req(`${p(id)}/assistant`),
  updateAssistant: (id: string, body: unknown) => req(`${p(id)}/assistant`, { method: 'PATCH', body: JSON.stringify(body) }),
}

export const apiBase = BASE || window.location.origin
