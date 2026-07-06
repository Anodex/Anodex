import { useEffect, useRef } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import styles from './ChatConstellation.module.css'

interface Node {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  color: string
}

const PALETTE = ['#21e9ff', '#4f8cff', '#7c5cff']
const DENSITY = 140
const LINK_DISTANCE = 150
const MOUSE_RADIUS = 150

/**
 * Animated node-and-link background, ported from the marketing site's hero
 * constellation (Anodex.dc.html). Sized to its parent via ResizeObserver
 * rather than the window, since it lives inside the chat panel, not
 * full-bleed. Mounted only for the lifetime of `ChatEmptyState` — no visible
 * flag needed, unmounting (chat starting) tears the animation down.
 *
 * Respects the existing Appearance > "Reduced motion" setting in addition to
 * the OS-level `prefers-reduced-motion` media query, since this is a canvas
 * loop rather than a CSS transition/animation — the app's blanket
 * `[data-reduced-motion] * { transition-duration }` CSS rule can't touch it.
 */
export function ChatConstellation(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const reducedMotion = useSettingsStore((s) => s.settings?.appearance.reducedMotion ?? false)

  useEffect(() => {
    const canvas = canvasRef.current
    const container = canvas?.parentElement
    if (!canvas || !container) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    if (reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      return
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const mouse = { x: -9999, y: -9999 }
    let width = 0
    let height = 0
    let nodes: Node[] = []
    let raf = 0

    const resize = (): void => {
      width = container.clientWidth
      height = container.clientHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const count = Math.round((DENSITY * (width * height)) / (1440 * 900))
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.28,
        vy: (Math.random() - 0.5) * 0.28,
        r: Math.random() * 1.8 + 1,
        color: PALETTE[(Math.random() * PALETTE.length) | 0]
      }))
    }

    const onMouseMove = (event: MouseEvent): void => {
      const rect = container.getBoundingClientRect()
      mouse.x = event.clientX - rect.left
      mouse.y = event.clientY - rect.top
    }

    const draw = (): void => {
      ctx.clearRect(0, 0, width, height)

      for (const node of nodes) {
        node.x += node.vx
        node.y += node.vy
        if (node.x < 0 || node.x > width) node.vx *= -1
        if (node.y < 0 || node.y > height) node.vy *= -1
        const dxm = node.x - mouse.x
        const dym = node.y - mouse.y
        const dm = Math.hypot(dxm, dym)
        if (dm < MOUSE_RADIUS) {
          node.x += (dxm / dm) * 0.6
          node.y += (dym / dm) * 0.6
        }
      }

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]
          const b = nodes[j]
          const d = Math.hypot(a.x - b.x, a.y - b.y)
          if (d < LINK_DISTANCE) {
            ctx.globalAlpha = (1 - d / LINK_DISTANCE) * 0.5
            ctx.strokeStyle = a.color
            ctx.lineWidth = 0.9
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
      }

      ctx.globalAlpha = 1
      for (const node of nodes) {
        ctx.beginPath()
        ctx.fillStyle = node.color
        ctx.shadowColor = node.color
        ctx.shadowBlur = 8
        ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.shadowBlur = 0

      raf = requestAnimationFrame(draw)
    }

    resize()
    draw()

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)
    window.addEventListener('mousemove', onMouseMove)

    return () => {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      window.removeEventListener('mousemove', onMouseMove)
    }
  }, [reducedMotion])

  return <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
}
