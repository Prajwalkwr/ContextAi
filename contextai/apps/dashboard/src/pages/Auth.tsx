import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { api, session } from '../lib/api'
import Particles from '../components/Particles'

type Mode = 'login' | 'register'

const nav = [
  { href: '#engine', label: 'Engine' },
  { href: '#how', label: 'How It Works' },
  { href: '#proof', label: 'Proof' },
]

const capabilities = [
  { title: 'Project Understanding', text: 'Maps your stack, routes, models and auth from the repository. Every claim links to a file and line.', icon: 'M8 9l-4 3 4 3M16 9l4 3-4 3M13.5 6l-3 12' },
  { title: 'Live Data Connectors', text: 'MongoDB, PostgreSQL, MySQL, REST, GraphQL, Firebase and Sheets. Allowlisted, read-only, encrypted.', icon: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3' },
  { title: 'Evidence-Backed Answers', text: 'Plans queries, calculates and verifies. Every answer carries evidence, limitations and confidence.', icon: 'M11 4a7 7 0 105.2 11.7L21 20M8 11h6M11 8v6' },
  { title: 'Secure SDK Integration', text: 'Add the SDK to any app. Public keys can only ask, and each project’s knowledge stays isolated.', icon: 'M12 3l7 3v6c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6l7-3zM9 12l2 2 4-4' },
]

const steps = [
  { title: 'Understand', text: 'Connect a GitHub repository or website. ContextAI maps the code with file and line references.' },
  { title: 'Connect Data', text: 'Add a database or API. Only allowlisted collections are reachable, always read-only.' },
  { title: 'Define Meaning', text: 'Confirm what your terms mean, like “failure” or “profit”, so answers follow your rules.' },
  { title: 'Investigate', text: 'Ask from the SDK, REST API or console and get evidence, limitations and confidence.' },
]

const stats = [
  { value: 5, label: 'Database & API Connectors' },
  { value: 7, label: 'Backend Languages Analysed' },
  { value: 52, label: 'Automated Tests Passing' },
  { value: 33, suffix: '/33', label: 'Core Checks Verified' },
  { value: 149, suffix: 'ms', label: 'Median Answer Time' },
]

const stack = ['MongoDB', 'PostgreSQL', 'MySQL', 'Supabase', 'Firebase', 'Firestore', 'GraphQL', 'REST APIs', 'Google Sheets', 'GitHub', 'Express', 'Django', 'FastAPI', 'Laravel', 'Spring', 'Rails', 'ASP.NET', 'Go']

function useInView<T extends HTMLElement>(threshold = 0.2) {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setInView(true); io.disconnect() } }, { threshold })
    io.observe(el)
    return () => io.disconnect()
  }, [threshold])
  return [ref, inView] as const
}

function useParallax<T extends HTMLElement>(speed: number) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    const anchor = el?.parentElement
    if (!el || !anchor || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    const update = () => {
      raf = 0
      if (window.innerWidth < 640) { el.style.transform = ''; return }
      const r = anchor.getBoundingClientRect()
      el.style.transform = `translate3d(0, ${((r.top + r.height / 2 - window.innerHeight / 2) * speed).toFixed(1)}px, 0)`
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update) }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [speed])
  return ref
}

function FadeIn({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const [ref, inView] = useInView<HTMLDivElement>(0.15)
  return (
    <div ref={ref} className={`transition-all duration-1000 ease-[cubic-bezier(.2,.7,.2,1)] ${inView ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  )
}

function Stat({ value, suffix = '', label, delay }: { value: number; suffix?: string; label: string; delay: number }) {
  const [ref, inView] = useInView<HTMLDivElement>(0.4)
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!inView) return
    let raf = 0
    const start = performance.now() + delay
    const tick = (t: number) => {
      const p = Math.max(0, Math.min(1, (t - start) / 1400))
      setN(Math.round(value * (1 - Math.pow(1 - p, 3))))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [inView, value, delay])
  return (
    <div ref={ref} className="text-center">
      <div className="text-5xl font-medium tabular-nums text-vista-coral sm:text-6xl lg:text-[64px]">{n}{suffix}</div>
      <div className="mx-auto mt-4 max-w-[12rem] text-sm leading-snug text-vista-mint">{label}</div>
    </div>
  )
}

function Brand() {
  return (
    <a href="#top" className="flex items-center">
      <img src="/contextai-logo.png" alt="ContextAI — Intelligent Answers" className="h-auto w-[150px] object-contain sm:w-[185px]" />
    </a>
  )
}

function CoralButton({ children, onClick, href, className = '' }: { children: ReactNode; onClick?: () => void; href?: string; className?: string }) {
  const cls = `inline-flex items-center justify-center rounded-lg bg-vista-coral px-6 py-2.5 text-[15px] text-black transition duration-300 hover:bg-[#ff7a62] hover:shadow-[0_10px_30px_-10px_rgba(255,96,68,.8)] active:scale-[.98] ${className}`
  return href ? <a href={href} className={cls}>{children}</a> : <button type="button" onClick={onClick} className={cls}>{children}</button>
}

function Header({ onAuth }: { onAuth: (m: Mode) => void }) {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  return (
    <header className={`fixed inset-x-0 top-0 z-40 transition-colors duration-500 ${scrolled ? 'bg-black/85 backdrop-blur-md' : ''}`}>
      <div className="mx-auto flex max-w-[1400px] items-center justify-between px-5 py-3 sm:px-10">
        <Brand />
        <div className="flex items-center gap-6">
          <nav className="flex items-center rounded-xl border border-white/10 bg-[#1d1e1b]/90 p-1.5 backdrop-blur">
            <div className="hidden items-center lg:flex">
              {nav.map((n) => <a key={n.href} href={n.href} className="px-4 text-[15px] text-vista-mint transition hover:text-vista-coral">{n.label}</a>)}
            </div>
            <CoralButton onClick={() => onAuth('register')} className="whitespace-nowrap lg:ml-2">Get Started</CoralButton>
            <button type="button" onClick={() => setOpen(!open)} className="ml-2 p-2 text-vista-mint lg:hidden" aria-label="Menu" aria-expanded={open}>
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.8}><path d={open ? 'M6 6l12 12M18 6L6 18' : 'M4 7h16M4 12h16M4 17h16'} /></svg>
            </button>
          </nav>
          <button type="button" onClick={() => onAuth('login')} className="hidden items-center gap-2 whitespace-nowrap text-[15px] text-vista-coral transition hover:text-[#ff8a74] sm:flex">
            <svg viewBox="0 0 24 24" className="h-7 w-7" fill="currentColor" aria-hidden><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 4a3.5 3.5 0 110 7 3.5 3.5 0 010-7zm0 14a8 8 0 01-6.2-2.9C7 15.4 9.4 14.5 12 14.5s5 .9 6.2 2.6A8 8 0 0112 20z" /></svg>
            Log In
          </button>
        </div>
      </div>
      {open && (
        <div className="mx-5 mb-3 rounded-xl border border-white/10 bg-[#1d1e1b] p-2 lg:hidden">
          {nav.map((n) => <a key={n.href} href={n.href} onClick={() => setOpen(false)} className="block rounded-lg px-4 py-3 text-vista-mint hover:bg-white/5">{n.label}</a>)}
          <button type="button" onClick={() => { setOpen(false); onAuth('login') }} className="block w-full rounded-lg px-4 py-3 text-left text-vista-coral hover:bg-white/5">Log In</button>
        </div>
      )}
    </header>
  )
}

function AuthDialog({ mode, onMode, onClose }: { mode: Mode; onMode: (m: Mode) => void; onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const first = useRef<HTMLInputElement>(null)

  useEffect(() => {
    first.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = '' }
  }, [onClose])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      session.save(mode === 'login' ? await api.login(email, password) : await api.register(email, password))
    } catch (err: any) {
      setError(err.message)
      setLoading(false)
    }
  }

  const field = 'w-full rounded-lg border border-white/10 bg-black/60 px-4 py-3 text-[15px] text-vista-mint outline-none transition placeholder:text-white/30 focus:border-vista-coral/70 focus:ring-4 focus:ring-vista-coral/10'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-5 backdrop-blur-sm animate-fade-up [animation-duration:.3s]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="auth-title" className="relative w-full max-w-md rounded-2xl border border-white/10 bg-[#141513] p-8 font-plex shadow-[0_40px_120px_-30px_rgba(255,96,68,.35)]">
        <button type="button" onClick={onClose} aria-label="Close" className="absolute right-4 top-4 p-1 text-white/40 transition hover:text-vista-mint">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8}><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
        <img src="/contextai-logo.png" alt="ContextAI — Intelligent Answers" className="h-auto w-48 object-contain" />
        <h2 id="auth-title" className="mt-5 text-2xl text-vista-mint">{mode === 'login' ? 'Welcome Back' : 'Create Your Account'}</h2>
        <p className="mt-2 text-sm text-white/50">{mode === 'login' ? 'Sign in to the developer console.' : 'Projects you create are visible only to you.'}</p>
        <div className="mt-7 space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs uppercase tracking-[0.14em] text-white/50">Email</span>
            <input ref={first} className={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs uppercase tracking-[0.14em] text-white/50">Password</span>
            <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </label>
          {error && <div role="alert" className="rounded-lg border border-vista-coral/30 bg-vista-coral/10 px-4 py-2.5 text-sm text-[#ffb3a5]">{error}</div>}
          <button type="submit" disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-lg bg-vista-coral py-3 text-[15px] text-black transition hover:bg-[#ff7a62] disabled:opacity-60">
            {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-black" />}
            {mode === 'login' ? 'Log In' : 'Create Account'}
          </button>
        </div>
        <p className="mt-6 text-center text-sm text-white/50">
          {mode === 'login' ? 'New here? ' : 'Have an account? '}
          <button type="button" onClick={() => { onMode(mode === 'login' ? 'register' : 'login'); setError(null) }} className="text-vista-coral hover:underline">{mode === 'login' ? 'Create an account' : 'Log in'}</button>
        </p>
      </form>
    </div>
  )
}

function CapabilityCard({ c, rotate }: { c: typeof capabilities[number]; rotate: number }) {
  return (
    <div className="rounded-lg bg-vista-card p-6 shadow-[0_30px_60px_-30px_rgba(0,0,0,.9)] transition duration-500 hover:!rotate-0 hover:bg-[#4d514a] sm:p-7" style={{ transform: `rotate(${rotate}deg)` }}>
      <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-vista-mint/80">
        <svg viewBox="0 0 24 24" className="h-6 w-6 text-vista-mint" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round"><path d={c.icon} /></svg>
      </div>
      <h3 className="mt-7 text-2xl leading-tight text-vista-mint sm:text-[26px]">{c.title}</h3>
      <p className="mt-6 text-[15px] leading-relaxed text-vista-mint/90">{c.text}</p>
    </div>
  )
}

function GlowHeading({ lines }: { lines: string[] }) {
  const [ref, inView] = useInView<HTMLHeadingElement>(0.35)
  return (
    <h2 ref={ref} className="text-4xl leading-[1.12] sm:text-5xl lg:text-[56px]">
      {lines.map((l, i) => (
        <span key={l} className="block transition-colors duration-[1400ms] ease-out" style={{ color: inView ? '#EFFFEB' : '#1d1e1c', transitionDelay: `${i * 220}ms` }}>{l}</span>
      ))}
    </h2>
  )
}

export default function Auth() {
  const [auth, setAuth] = useState<Mode | null>(null)
  const closeAuth = useCallback(() => setAuth(null), [])
  const leftCards = useParallax<HTMLDivElement>(-0.06)
  const rightCards = useParallax<HTMLDivElement>(0.08)
  const [stepsRef, stepsIn] = useInView<HTMLDivElement>(0.25)
  const headline: string[][] = [['One', 'AI'], ['Engine'], ['For', 'Every'], ['Project']]

  return (
    <div id="top" className="min-h-screen overflow-x-clip bg-black font-plex text-vista-mint selection:bg-vista-coral/40">
      <Header onAuth={setAuth} />

      <section className="relative flex min-h-[100svh] items-center overflow-hidden pb-10 pt-20" style={{ background: 'linear-gradient(180deg,#000 0%,#030507 50%,#2c3740 82%,#64727d 100%)' }}>
        <Particles className="absolute inset-0" />
        <div className="relative mx-auto w-full max-w-[1400px] px-5 sm:px-14">
          <h1 className="font-medium uppercase leading-[1]" style={{ width: '9ch', fontSize: 'clamp(32px, min(7.4vw, calc((100svh - 300px) / 4.3)), 108px)' }}>
            {headline.map((words, i) => (
              <span key={i} className="block overflow-hidden pb-[0.04em]">
                <span className="flex justify-between animate-line-up" style={{ animationDelay: `${150 + i * 120}ms` }}>
                  {words.map((w) => <span key={w}>{w}</span>)}
                </span>
              </span>
            ))}
          </h1>
          <p className="max-w-md text-[15px] leading-relaxed animate-fade-up" style={{ animationDelay: '750ms', marginTop: 'clamp(12px, 3svh, 24px)' }}>
            Learns each app’s code, data and business rules, then answers with real evidence.
          </p>
          <div className="animate-fade-up" style={{ animationDelay: '900ms', marginTop: 'clamp(16px, 4svh, 36px)' }}>
            <CoralButton href="#engine">Learn More</CoralButton>
          </div>
        </div>
      </section>

      <section id="engine" className="relative mx-auto grid max-w-[1400px] scroll-mt-20 gap-16 px-5 py-24 sm:px-12 lg:grid-cols-2 lg:gap-10 lg:py-36">
        <div className="lg:sticky lg:top-40 lg:self-start">
          <FadeIn>
            <h2 className="text-4xl leading-[1.12] sm:text-5xl lg:text-[52px]">Let Your Project Data Answer Its Own Questions</h2>
          </FadeIn>
          <FadeIn delay={150}>
            <p className="mt-14 max-w-md border-l border-vista-coral pl-5 text-[15px] leading-relaxed">
              ContextAI connects to your repository, database and APIs, learns how your application works, and investigates real questions with queries you can inspect.
            </p>
          </FadeIn>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 sm:gap-5">
          <div ref={leftCards} className="space-y-6 will-change-transform">
            <FadeIn><CapabilityCard c={capabilities[0]} rotate={-1.5} /></FadeIn>
            <FadeIn delay={120}><CapabilityCard c={capabilities[2]} rotate={0} /></FadeIn>
          </div>
          <div ref={rightCards} className="space-y-6 will-change-transform sm:pt-24">
            <FadeIn delay={80}><CapabilityCard c={capabilities[1]} rotate={2.5} /></FadeIn>
            <FadeIn delay={200}><CapabilityCard c={capabilities[3]} rotate={-2} /></FadeIn>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-[1400px] items-center gap-12 px-5 py-24 sm:px-12 lg:grid-cols-2 lg:py-36">
        <GlowHeading lines={['Grounded', 'Answers.', 'Honest', 'Limits.']} />
        <FadeIn delay={300} className="lg:pl-10">
          <p className="max-w-md border-l border-vista-coral pl-5 text-[15px] leading-relaxed">
            Every number comes from a validated, read-only query. When data is missing, ContextAI says so instead of guessing, and any change to your data needs an owner’s approval.
          </p>
          <CoralButton href="#how" className="ml-5 mt-10">Learn More</CoralButton>
        </FadeIn>
      </section>

      <section id="how" className="mx-auto max-w-[1400px] scroll-mt-20 px-5 py-24 sm:px-12">
        <FadeIn><h2 className="max-w-2xl text-3xl leading-tight sm:text-[40px]">From Repository to Evidence in Four Steps</h2></FadeIn>
        <div ref={stepsRef} className="mt-16 grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8">
          {steps.map((s, i) => (
            <div key={s.title} className={`transition-all duration-700 ${stepsIn ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'}`} style={{ transitionDelay: `${i * 140}ms` }}>
              <div className="h-px origin-left bg-vista-coral transition-transform duration-1000" style={{ transform: `scaleX(${stepsIn ? 1 : 0})`, transitionDelay: `${i * 140 + 200}ms` }} />
              <div className="mt-6 text-sm text-vista-coral">0{i + 1}</div>
              <h3 className="mt-3 text-2xl">{s.title}</h3>
              <p className="mt-4 text-[15px] leading-relaxed text-vista-mint/75">{s.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="proof" className="relative mt-16 scroll-mt-20 overflow-hidden py-28 lg:py-36" style={{ background: 'linear-gradient(180deg,#000 0%,#05080b 55%,#1e2a33 100%)' }}>
        <Particles className="absolute inset-0" density={0.8} seed={31} />
        <div className="relative mx-auto max-w-[1400px] px-5 sm:px-12">
          <FadeIn className="text-center">
            <h2 className="text-3xl sm:text-[34px]">Verified, Not Claimed</h2>
            <p className="mx-auto mt-4 max-w-lg text-sm text-vista-mint/60">Measured by ContextAI’s own automated tests and end-to-end verification.</p>
          </FadeIn>
          <div className="mt-20 grid grid-cols-2 gap-x-6 gap-y-14 sm:grid-cols-3 lg:grid-cols-5">
            {stats.map((s, i) => <Stat key={s.label} {...s} delay={i * 120} />)}
          </div>
        </div>
      </section>

      <section className="py-24">
        <FadeIn><h2 className="text-center text-3xl sm:text-[34px]">Works With Your Stack</h2></FadeIn>
        <div className="group relative mt-14 overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_12%,black_88%,transparent)]">
          <div className="flex w-max animate-marquee group-hover:[animation-play-state:paused]">
            {[...stack, ...stack].map((s, i) => (
              <span key={i} aria-hidden={i >= stack.length} className="mx-3 whitespace-nowrap rounded-lg border border-white/10 px-6 py-3 text-lg text-vista-mint/70 transition hover:border-vista-coral/60 hover:text-vista-mint">{s}</span>
            ))}
          </div>
        </div>
      </section>

      <footer className="mx-auto max-w-[1400px] px-5 pb-10 sm:px-12">
        <div className="h-px bg-white/80" />
        <div className="grid gap-12 py-16 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <Brand />
            <p className="mt-6 max-w-sm text-[15px] leading-relaxed text-vista-mint/70">One AI engine. Multiple connected projects. Separate project knowledge. Real project data.</p>
          </div>
          <nav className="flex flex-col gap-3 text-[15px]">
            {nav.map((n) => <a key={n.href} href={n.href} className="w-fit underline underline-offset-4 transition hover:text-vista-coral">{n.label}</a>)}
            <button type="button" onClick={() => setAuth('login')} className="w-fit underline underline-offset-4 transition hover:text-vista-coral">Log In</button>
          </nav>
          <div>
            <p className="text-[15px] leading-relaxed text-vista-mint/70">Connect your first project in minutes.</p>
            <CoralButton onClick={() => setAuth('register')} className="mt-6">Get Started</CoralButton>
          </div>
        </div>
        <div className="text-sm text-vista-mint/50">© {new Date().getFullYear()} ContextAI. Read-only by default, evidence on every answer.</div>
      </footer>

      {auth && <AuthDialog mode={auth} onMode={setAuth} onClose={closeAuth} />}
    </div>
  )
}
