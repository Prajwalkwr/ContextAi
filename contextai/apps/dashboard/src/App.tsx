import { useEffect, useRef, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { session } from './lib/api'
import { Logo } from './components/ui'
import Auth from './pages/Auth'
import Overview from './pages/Overview'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import Investigate from './pages/Investigate'
import Logs from './pages/Logs'
import Docs from './pages/Docs'

const nav = [
  { to: '/', label: 'Overview', icon: 'M3 12l9-8 9 8M5 10v10h14V10' },
  { to: '/projects', label: 'Projects', icon: 'M4 6h16M4 12h16M4 18h10' },
  { to: '/investigate', label: 'Investigate', icon: 'M11 4a7 7 0 105.2 11.7L21 20' },
  { to: '/logs', label: 'Logs & audit', icon: 'M5 4h14v16H5zM9 8h6M9 12h6M9 16h3' },
  { to: '/docs', label: 'Integrate', icon: 'M8 9l-4 3 4 3M16 9l4 3-4 3M13 6l-2 12' },
]

function ScrollProgress({ target }: { target: React.RefObject<HTMLElement> }) {
  const [p, setP] = useState(0)
  useEffect(() => {
    const el = target.current
    if (!el) return
    const on = () => setP(el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0)
    el.addEventListener('scroll', on, { passive: true })
    return () => el.removeEventListener('scroll', on)
  }, [target])
  return <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-[2px] origin-left bg-gradient-to-r from-violet-500 to-sky-400 transition-transform duration-150" style={{ transform: `scaleX(${p})` }} />
}

export default function App() {
  const [authed, setAuthed] = useState(!!session.token)
  const location = useLocation()
  const main = useRef<HTMLElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const sync = () => setAuthed(!!session.token)
    window.addEventListener('ctx-auth', sync)
    return () => window.removeEventListener('ctx-auth', sync)
  }, [])
  useEffect(() => { main.current?.scrollTo({ top: 0 }); setMenuOpen(false) }, [location.pathname])

  if (!authed) return <Auth />

  return (
    <div className="dashboard-shell flex h-screen overflow-hidden bg-black text-zinc-100">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-white/[0.08] bg-black md:flex">
        <Logo className="px-6 pb-6 pt-7" />
        <nav className="flex-1 space-y-0.5 px-3">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${isActive ? 'bg-butter text-ink-950' : 'text-zinc-500 hover:bg-butter/[0.08] hover:text-butter'}`}>
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d={n.icon} /></svg>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="m-3 rounded-xl border border-white/[0.05] bg-white/[0.02] p-3">
          <div className="truncate text-xs text-zinc-300">{session.user?.email}</div>
          <button onClick={() => session.clear()} className="mt-1 text-xs text-zinc-500 transition hover:text-butter">Sign out</button>
        </div>
      </aside>

      <main ref={main} className="relative min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-black">
        <ScrollProgress target={main} />
        <div className="sticky top-0 z-10 border-b border-white/[0.08] bg-black md:hidden">
          <div className="flex items-center justify-between px-5 py-3">
            <Logo />
            <button type="button" onClick={() => setMenuOpen(!menuOpen)} className="p-2 text-zinc-300 hover:text-butter" aria-label="Menu" aria-expanded={menuOpen}>
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8}><path d={menuOpen ? 'M6 6l12 12M18 6L6 18' : 'M4 7h16M4 12h16M4 17h16'} /></svg>
            </button>
          </div>
          {menuOpen && (
            <nav className="space-y-0.5 px-3 pb-3">
              {nav.map((n) => <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `block rounded-xl px-3 py-2.5 text-sm ${isActive ? 'bg-butter text-ink-950' : 'text-zinc-400 hover:bg-butter/[0.08] hover:text-butter'}`}>{n.label}</NavLink>)}
              <div className="flex items-center justify-between px-3 pt-2 text-xs">
                <span className="truncate text-zinc-500">{session.user?.email}</span>
                <button onClick={() => session.clear()} className="text-zinc-400 hover:text-butter">Sign out</button>
              </div>
            </nav>
          )}
        </div>
        <div key={location.pathname} className="mx-auto max-w-6xl px-5 py-10 sm:px-10">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:id" element={<ProjectDetail />} />
            <Route path="/investigate" element={<Investigate />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/docs" element={<Docs />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </div>
      </main>
    </div>
  )
}
