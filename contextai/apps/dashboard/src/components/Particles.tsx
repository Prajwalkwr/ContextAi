import { useEffect, useRef } from 'react'

type Point = { x: number; y: number; z: number; a: number }

function field(seed: number, density: number): Point[] {
  let s = seed
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  const points: Point[] = []
  for (let i = 0; i < Math.round(16 * density); i++) {
    const origin = { x: rand() * 2.4 - 1.2, y: rand() * 1.2 - 0.6, z: rand() * 2 - 1 }
    const vertical = rand() < 0.15
    const dir = vertical ? { x: (rand() - 0.5) * 0.08, y: 1, z: (rand() - 0.5) * 0.2 } : { x: rand() * 2 - 1, y: (rand() - 0.5) * 0.35, z: rand() * 2 - 1 }
    const len = 0.3 + rand() * 0.9
    const count = 10 + Math.floor(rand() * 28)
    for (let j = 0; j < count; j++) {
      const t = (rand() - 0.5) * len
      points.push({ x: origin.x + dir.x * t, y: origin.y + dir.y * t * (vertical ? 0.4 : 1) + (rand() - 0.5) * 0.015, z: origin.z + dir.z * t, a: 0.45 + rand() * 0.55 })
    }
  }
  for (let i = 0; i < Math.round(10 * density); i++) {
    const c = { x: rand() * 2.4 - 1.2, y: rand() * 1.1 - 0.55, z: rand() * 2 - 1 }
    for (let j = 0; j < 24; j++) points.push({ x: c.x + (rand() - 0.5) * 0.18, y: c.y + (rand() - 0.5) * 0.1, z: c.z + (rand() - 0.5) * 0.18, a: 0.4 + rand() * 0.6 })
  }
  for (let i = 0; i < Math.round(280 * density); i++) points.push({ x: rand() * 3 - 1.5, y: rand() * 1.6 - 0.8, z: rand() * 2 - 1, a: 0.15 + rand() * 0.6 })
  return points
}

export default function Particles({ className = '', density = 1, seed = 7 }: { className?: string; density?: number; seed?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const points = field(seed, density)
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let width = 0
    let height = 0
    let dpr = 1
    let angle = 0
    let tilt = 0
    let targetTilt = 0
    let visible = true
    let raf = 0
    let last = performance.now()

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      draw()
    }

    function draw() {
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx!.clearRect(0, 0, width, height)
      ctx!.fillStyle = '#e6f2ea'
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const scale = Math.max(width, height) * 0.75
      for (const p of points) {
        const x = p.x * cos - p.z * sin
        const depth = p.x * sin + p.z * cos + 2.4
        const px = width / 2 + (x / depth) * scale
        const py = height * 0.42 + ((p.y + tilt) / depth) * scale
        if (px < -4 || px > width + 4 || py < -4 || py > height + 4) continue
        const size = Math.max(0.6, 2.4 / depth)
        ctx!.globalAlpha = Math.min(1, p.a * (3.4 - depth) * 0.75)
        ctx!.fillRect(px, py, size, size)
      }
      ctx!.globalAlpha = 1
    }

    const loop = (now: number) => {
      const dt = Math.min(64, now - last)
      last = now
      angle += dt * 0.00004
      tilt += (targetTilt - tilt) * 0.04
      draw()
      raf = visible ? requestAnimationFrame(loop) : 0
    }

    const onMove = (e: MouseEvent) => { targetTilt = (e.clientY / window.innerHeight - 0.5) * 0.08 }
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      if (visible && !raf && !still) { last = performance.now(); raf = requestAnimationFrame(loop) }
    })
    io.observe(canvas)
    resize()
    if (!still) window.addEventListener('mousemove', onMove, { passive: true })

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      window.removeEventListener('mousemove', onMove)
    }
  }, [density, seed])

  return <canvas ref={ref} aria-hidden className={`pointer-events-none block h-full w-full ${className}`} />
}
