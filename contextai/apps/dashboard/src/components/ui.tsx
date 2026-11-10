import { ReactNode, useEffect, useRef, useState } from 'react'

export function Logo({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <img src="/contextai-logo.png" alt="ContextAI — Intelligent Answers" className="h-auto w-[150px] object-contain" />
    </div>
  )
}

export function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { el.classList.add('is-visible'); io.disconnect() }
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return <div ref={ref} className={`reveal ${className}`} style={{ transitionDelay: `${delay}ms` }}>{children}</div>
}

export function CountUp({ value, duration = 900 }: { value: number; duration?: number }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    let raf = 0
    const start = performance.now()
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration)
      setN(Math.round(value * (1 - Math.pow(1 - p, 3))))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])
  return <>{n.toLocaleString()}</>
}

type ButtonProps = { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; type?: 'button' | 'submit'; className?: string; loading?: boolean }
export function Button({ children, onClick, variant = 'primary', disabled, type = 'button', className = '', loading }: ButtonProps) {
  const styles = {
    primary: 'bg-butter text-ink-950 shadow-[0_8px_24px_-8px_rgba(255,242,180,.28)] hover:bg-[#f6e8a4] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-butter',
    ghost: 'border border-white/[0.08] bg-white/[0.03] text-zinc-200 hover:border-butter/40 hover:bg-butter/[0.08] hover:text-butter focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-butter',
    danger: 'border border-red-500/20 bg-red-500/10 text-red-300 hover:bg-red-500/20',
  }[variant]
  return (
    <button type={type} onClick={onClick} disabled={disabled || loading} className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}>
      {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-950/25 border-t-ink-950" />}
      {children}
    </button>
  )
}

const tones = {
  green: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  amber: 'border-amber-500/20 bg-amber-500/10 text-amber-300',
  red: 'border-red-500/20 bg-red-500/10 text-red-300',
  violet: 'border-violet-500/20 bg-violet-500/10 text-violet-300',
  zinc: 'border-white/[0.08] bg-white/[0.04] text-zinc-400',
}
export type Tone = keyof typeof tones
export function Badge({ children, tone = 'zinc' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>
}

export const statusTone = (s?: string): Tone =>
  ['connected', 'indexed', 'completed', 'success', 'high'].includes(s || '') ? 'green'
    : ['indexing', 'running', 'queued', 'pending', 'medium', 'completed_with_warnings'].includes(s || '') ? 'amber'
      : ['error', 'failed', 'low', 'insufficient_data'].includes(s || '') ? 'red' : 'zinc'

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4 animate-fade-up">
      <div>
        {eyebrow && <div className="eyebrow mb-2">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-[28px]">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/[0.08] px-6 py-10 text-center">
      <div className="text-sm font-medium text-zinc-300">{title}</div>
      {children && <div className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-zinc-500">{children}</div>}
    </div>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="inline-flex gap-1 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)} aria-pressed={value === t.id} className={`rounded-lg px-3.5 py-1.5 text-sm transition ${value === t.id ? 'bg-butter text-ink-950 shadow-sm' : 'text-zinc-500 hover:text-butter'}`}>{t.label}</button>
      ))}
    </div>
  )
}

export function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-xl border border-white/[0.06] bg-black/40 p-4 font-mono text-[12px] leading-relaxed text-zinc-300">{children}</pre>
      <button onClick={() => { navigator.clipboard.writeText(children); setCopied(true); setTimeout(() => setCopied(false), 1200) }} className="absolute right-2 top-2 rounded-md border border-white/[0.08] bg-ink-900 px-2 py-1 text-[11px] text-zinc-400 opacity-0 transition group-hover:border-butter/40 group-hover:text-butter group-hover:opacity-100">{copied ? 'Copied' : 'Copy'}</button>
    </div>
  )
}

export function ErrorNote({ error }: { error?: string | null }) {
  if (!error) return null
  return <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-300">{error}</div>
}

export const timeAgo = (iso?: string) => {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}
