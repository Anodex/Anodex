import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { themeModeOf } from '../../lib/themePresets'
import { glowSprite, lerp, rampAt, rgba, type Rgb } from './backgroundCanvas'
import styles from './ChatBackground.module.css'

interface TracePoint {
  x: number
  y: number
}

interface Trace {
  pts: TracePoint[]
  /** Cumulative polyline length at each point, for packet positioning. */
  cum: number[]
  dir: number
  head: TracePoint
  segProgress: number
  targetSegs: number
  speed: number
  state: 'growing' | 'routing' | 'alive' | 'fading'
  layer: 0 | 1
  hue: number
  w: number
  /** Draw a tiny IC footprint at the start point instead of a via. */
  chip: boolean
  player: boolean
  /** Exempt from the keep-out ellipse (user-initiated traces). */
  free: boolean
  fadeAt: number
  alpha: number
  highlight: number
  endFlash: number
}

interface Packet {
  tr: Trace
  dist: number
  dir: 1 | -1
  speed: number
  col: Rgb
}

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  decay: number
  r: number
  col: Rgb
}

interface Bloom {
  x: number
  y: number
  r: number
  v: number
  alpha: number
}

interface CircuitPalette {
  /** Trace/packet color ramp, cyan → blue → violet. */
  ramp: [Rgb, Rgb, Rgb]
  glowBlend: GlobalCompositeOperation
  /** Stroke color of the faint hexagonal board etch. */
  grid: string
  coreAlpha: number
  glowAlpha: number
  packetAlpha: number
  /** Radial ground wash drawn under everything, [inner, outer] rgba strings. */
  wash: [string, string]
  vignette: number
  halo: number
}

/** Dark ramp is the constellation palette; the light ramp is the same hues
 *  pulled darker so they hold contrast on the light surface. */
const PALETTES: Record<'dark' | 'light', CircuitPalette> = {
  dark: {
    ramp: [
      [33, 233, 255],
      [79, 140, 255],
      [124, 92, 255]
    ],
    glowBlend: 'lighter',
    grid: 'rgba(140, 160, 220, 0.045)',
    coreAlpha: 0.6,
    glowAlpha: 0.12,
    packetAlpha: 0.95,
    wash: ['rgba(15, 15, 24, 0.8)', 'rgba(10, 10, 12, 0)'],
    vignette: 0.45,
    halo: 0.08
  },
  light: {
    ramp: [
      [14, 165, 201],
      [47, 111, 224],
      [104, 71, 209]
    ],
    glowBlend: 'source-over',
    grid: 'rgba(70, 100, 180, 0.07)',
    coreAlpha: 0.55,
    glowAlpha: 0.1,
    packetAlpha: 0.9,
    wash: ['rgba(238, 242, 251, 0.85)', 'rgba(255, 255, 255, 0)'],
    vignette: 0,
    halo: 0.07
  }
}

// Classic PCB routing: 8 directions (orthogonal + true 45°) on a fixed grid.
const GRID = 14
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1]
]

const TRACE_CAP = 95 // traces per 1440×900 of container
const MAX_PACKETS = 70
const MAX_SPARKS = 260

/**
 * "Silicon Bloom" — the alternate empty-state background (Appearance > Chat
 * background). Where the deep field looks out at space, this looks into the
 * machine: a living motherboard where luminous circuit traces etch themselves
 * across the board on real PCB routing rules (fixed grid, 90°/45° bends),
 * ending in vias and IC footprints, while data packets stream along finished
 * traces and the network endlessly fades and regrows. A faint hexagonal etch
 * echoes the hexagon in the Anodex logo, and an elliptical "keep-out zone"
 * around the hero copy — a real PCB concept — stops auto-routed traces from
 * crowding the text.
 *
 * Interactive: the cursor is a probe (nearby traces glow, tiny arcs flicker
 * to the closest one), clicking empty space seeds a bloom of new traces with
 * a chip footprint, and dragging routes a player trace that snaps to the 45°
 * grid, joins the network, and carries packets. User-initiated traces are
 * exempt from the keep-out — it's their board. Input is observed from
 * window-level listeners gated to non-interactive targets, so the canvas
 * keeps `pointer-events: none`.
 *
 * Mounting, sizing, theming, and reduced-motion behavior all match
 * `ChatConstellation` — see that component for the rationale. Under reduced
 * motion the board is grown instantly and drawn once as a still. Pill
 * controls bottom-right regrow the board and pause/resume; per-session only.
 */
export function ChatCircuit(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const reducedMotion = useSettingsStore((s) => s.settings?.appearance.reducedMotion ?? false)
  const themeMode = useSettingsStore((s) => themeModeOf(s.settings?.appearance.theme ?? 'midnight'))

  const [paused, setPaused] = useState(false)
  // The effect re-runs on theme changes; a ref (not the state) tells the
  // rebuilt scene whether to stay paused without re-running on toggle.
  const pausedRef = useRef(false)
  const setRunningRef = useRef<((running: boolean) => void) | null>(null)
  const regrowRef = useRef<(() => void) | null>(null)

  const motionDisabled =
    reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches

  useEffect(() => {
    const canvas = canvasRef.current
    const container = canvas?.parentElement
    if (!canvas || !container) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const staticOnly =
      reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
    const resolveDark = (): boolean =>
      themeMode === 'dark' || (themeMode === 'system' && systemDark.matches)

    let palette = PALETTES[resolveDark() ? 'dark' : 'light']
    let haloSprite = glowSprite(palette.ramp[1], 64)

    // ------------------------------------------------------------ state
    let width = 0
    let height = 0
    let dpr = 1
    let traces: Trace[] = []
    const packets: Packet[] = []
    const sparks: Spark[] = []
    const blooms: Bloom[] = []
    let playerTrace: Trace | null = null
    let hexTile: CanvasPattern | null = null
    let washGrad: CanvasGradient | null = null
    let vignetteGrad: CanvasGradient | null = null
    let frame = 0
    let raf = 0
    let nextAutoAt = 0
    let nextPacketAt = 40
    let reseedTimer = 0

    const probe = { x: -9999, y: -9999, inside: false, down: false, moved: 0 }

    // Keep-out zone: an ellipse around the hero copy that auto-routed traces
    // refuse to enter — real boards have keep-outs, and it keeps the text
    // readable. Player traces and click blooms may go anywhere.
    const keepOut = { x: 0, y: 0, rx: 1, ry: 1 }
    const inKeepOut = (x: number, y: number): boolean => {
      const dx = (x - keepOut.x) / keepOut.rx
      const dy = (y - keepOut.y) / keepOut.ry
      return dx * dx + dy * dy < 1
    }

    const traceCap = (): number => Math.round((TRACE_CAP * width * height) / (1440 * 900))

    interface TraceOptions {
      dir?: number
      targetSegs?: number
      speed?: number
      layer?: 0 | 1
      hue?: number
      w?: number
      chip?: boolean
      player?: boolean
      free?: boolean
    }

    const makeTrace = (x: number, y: number, opts: TraceOptions = {}): Trace => ({
      pts: [{ x, y }],
      cum: [0],
      dir: opts.dir ?? (Math.random() * 8) | 0,
      head: { x, y },
      segProgress: 0,
      targetSegs: opts.targetSegs ?? 6 + ((Math.random() * 22) | 0),
      speed: opts.speed ?? 1.6 + Math.random() * 1.6,
      state: 'growing',
      layer: opts.layer ?? (Math.random() < 0.4 ? 0 : 1),
      hue: opts.hue ?? Math.random(),
      w: opts.w ?? (Math.random() < 0.4 ? 1.0 : 1.4),
      chip: opts.chip ?? false,
      player: opts.player ?? false,
      free: opts.free ?? false,
      fadeAt: frame + 1400 + ((Math.random() * 1400) | 0),
      alpha: 1,
      highlight: 0,
      endFlash: 0
    })

    const traceLength = (tr: Trace): number => tr.cum[tr.cum.length - 1]

    const commitPoint = (tr: Trace, x: number, y: number): void => {
      const last = tr.pts[tr.pts.length - 1]
      tr.cum.push(traceLength(tr) + Math.hypot(x - last.x, y - last.y))
      tr.pts.push({ x, y })
    }

    const finishTrace = (tr: Trace): void => {
      tr.state = 'alive'
      tr.endFlash = 1
      if (tr.pts.length >= 2) spawnPacket(tr, false)
    }

    const stepGrowth = (tr: Trace): void => {
      const last = tr.pts[tr.pts.length - 1]
      const d = DIRS[tr.dir]
      const target = { x: last.x + d[0] * GRID, y: last.y + d[1] * GRID }
      const segLen = Math.hypot(target.x - last.x, target.y - last.y)
      tr.segProgress += tr.speed
      if (tr.segProgress < segLen) {
        const t = tr.segProgress / segLen
        tr.head.x = lerp(last.x, target.x, t)
        tr.head.y = lerp(last.y, target.y, t)
        if (Math.random() < 0.3 && sparks.length < MAX_SPARKS) {
          sparks.push({
            x: tr.head.x,
            y: tr.head.y,
            vx: (Math.random() - 0.5) * 1.4,
            vy: (Math.random() - 0.5) * 1.4,
            life: 1,
            decay: 0.03 + Math.random() * 0.04,
            r: 0.6 + Math.random() * 1.1,
            col: rampAt(palette.ramp, tr.hue)
          })
        }
        return
      }
      tr.segProgress = 0
      commitPoint(tr, target.x, target.y)
      tr.head.x = target.x
      tr.head.y = target.y
      const margin = GRID * 2
      const out =
        target.x < margin ||
        target.x > width - margin ||
        target.y < margin ||
        target.y > height - margin
      if (
        out ||
        tr.pts.length > tr.targetSegs ||
        (!tr.player && !tr.free && inKeepOut(target.x, target.y))
      ) {
        finishTrace(tr)
        return
      }
      // Straight 64%, turn ±45° otherwise — the classic routed-board look.
      const roll = Math.random()
      if (roll > 0.64) tr.dir = (tr.dir + (roll > 0.82 ? 1 : 7)) % 8
    }

    // -------------------------------------------------------- packets
    const spawnPacket = (tr: Trace, reverse: boolean): void => {
      if (packets.length > MAX_PACKETS || tr.pts.length < 2) return
      packets.push({
        tr,
        dist: reverse ? traceLength(tr) : 0,
        dir: reverse ? -1 : 1,
        speed: 2.2 + Math.random() * 2.4,
        col: rampAt(palette.ramp, tr.hue)
      })
    }

    const pointAt = (tr: Trace, dist: number): { x: number; y: number; idx: number } => {
      const cum = tr.cum
      let i = 1
      while (i < cum.length && cum[i] < dist) i++
      if (i >= cum.length) {
        const p = tr.pts[tr.pts.length - 1]
        return { x: p.x, y: p.y, idx: tr.pts.length - 1 }
      }
      const a = tr.pts[i - 1]
      const b = tr.pts[i]
      const span = cum[i] - cum[i - 1] || 1
      const t = (dist - cum[i - 1]) / span
      return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), idx: i - 1 }
    }

    // ----------------------------------------------------------- seeds
    const seedBloom = (
      x: number,
      y: number,
      count: number,
      withChip: boolean,
      free = false
    ): void => {
      const spread = (Math.random() * 8) | 0
      for (let i = 0; i < count; i++) {
        traces.push(
          makeTrace(x, y, {
            dir: (spread + i * Math.ceil(8 / count) + ((Math.random() * 2) | 0)) % 8,
            chip: withChip && i === 0,
            hue: Math.random(),
            speed: 2 + Math.random() * 2,
            free
          })
        )
      }
      blooms.push({ x, y, r: 4, v: 4.5, alpha: 0.8 })
    }

    const seedInitial = (): void => {
      // The board wakes up: blooms ringed just outside the keep-out ellipse
      // (so none die on their first step), plus a few edge runners.
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.4
        seedBloom(
          keepOut.x + Math.cos(a) * keepOut.rx * (1.3 + Math.random() * 0.35),
          keepOut.y + Math.sin(a) * keepOut.ry * (1.45 + Math.random() * 0.4),
          3,
          i % 2 === 0
        )
      }
      for (let i = 0; i < 4; i++) {
        traces.push(
          makeTrace(Math.random() * width, Math.random() < 0.5 ? GRID * 3 : height - GRID * 3)
        )
      }
    }

    const autoSpawn = (): void => {
      if (traces.length >= traceCap()) return
      const alive = traces.filter((t) => t.state === 'alive' && !t.player)
      // Branch off an existing trace 60% of the time so the board reads as
      // one connected organism rather than scattered strokes.
      if (alive.length && Math.random() < 0.6) {
        const src = alive[(Math.random() * alive.length) | 0]
        const p = src.pts[(Math.random() * src.pts.length) | 0]
        traces.push(
          makeTrace(p.x, p.y, {
            hue: Math.min(1, Math.max(0, src.hue + (Math.random() - 0.5) * 0.3))
          })
        )
      } else {
        const x = GRID * 3 + Math.random() * (width - GRID * 6)
        const y = GRID * 3 + Math.random() * (height - GRID * 6)
        if (!inKeepOut(x, y)) traces.push(makeTrace(x, y))
      }
    }

    // ----------------------------------------------------------- input
    const toLocal = (event: PointerEvent): TracePoint => {
      const rect = container.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    /** True when the gesture began on a real control rather than dead space. */
    const onInteractiveTarget = (event: PointerEvent): boolean =>
      event.target instanceof Element &&
      event.target.closest('button, a, input, textarea, select, [role="button"]') !== null

    const snap = (v: number): number => Math.round(v / GRID) * GRID

    const routeToward = (tr: Trace, x: number, y: number): void => {
      // Commit grid steps along the nearest 45° direction while the cursor
      // stays ahead of the last committed point. The guard bound only exists
      // to keep a pathological event from looping forever — it must be large
      // enough that a fast flick (one event, hundreds of px) routes fully.
      for (let guard = 0; guard < 64; guard++) {
        const last = tr.pts[tr.pts.length - 1]
        const dx = x - last.x
        const dy = y - last.y
        if (Math.hypot(dx, dy) < GRID) break
        const angle = Math.atan2(dy, dx)
        const dirIdx = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8
        const d = DIRS[dirIdx]
        commitPoint(tr, last.x + d[0] * GRID, last.y + d[1] * GRID)
        if (sparks.length < MAX_SPARKS) {
          sparks.push({
            x: last.x,
            y: last.y,
            vx: (Math.random() - 0.5) * 1.6,
            vy: (Math.random() - 0.5) * 1.6,
            life: 1,
            decay: 0.03,
            r: 0.9,
            col: rampAt(palette.ramp, tr.hue)
          })
        }
      }
      const last = tr.pts[tr.pts.length - 1]
      tr.head.x = last.x
      tr.head.y = last.y
    }

    const onPointerMove = (event: PointerEvent): void => {
      const p = toLocal(event)
      if (probe.down) {
        probe.moved += Math.hypot(p.x - probe.x, p.y - probe.y)
        if (probe.moved > 8 && !playerTrace) {
          playerTrace = makeTrace(snap(probe.x), snap(probe.y), {
            player: true,
            layer: 1,
            w: 1.7,
            hue: Math.random(),
            chip: true,
            targetSegs: Number.MAX_SAFE_INTEGER
          })
          playerTrace.state = 'routing'
          traces.push(playerTrace)
        }
        if (playerTrace) routeToward(playerTrace, p.x, p.y)
      }
      probe.x = p.x
      probe.y = p.y
      probe.inside = p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (onInteractiveTarget(event)) return
      const p = toLocal(event)
      if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) return
      probe.down = true
      probe.moved = 0
      probe.x = p.x
      probe.y = p.y
    }

    const onPointerUp = (event: PointerEvent): void => {
      if (!probe.down) return
      probe.down = false
      if (playerTrace) {
        if (playerTrace.pts.length >= 3) {
          playerTrace.fadeAt = frame + 2600
          finishTrace(playerTrace)
          spawnPacket(playerTrace, true)
        } else {
          traces = traces.filter((t) => t !== playerTrace)
        }
        playerTrace = null
        return
      }
      if (probe.moved <= 8 && !onInteractiveTarget(event)) {
        const p = toLocal(event)
        seedBloom(snap(p.x), snap(p.y), 4 + ((Math.random() * 3) | 0), true, true)
      }
    }

    // ------------------------------------------------------- textures
    const buildHexTile = (): void => {
      // Faint hexagonal etch, echoing the hexagon in the Anodex logo.
      const s = 26 // hex radius
      const w = Math.round(s * 3)
      const h = Math.round(Math.sqrt(3) * s)
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d')
      if (!g) return
      g.strokeStyle = palette.grid
      g.lineWidth = 1
      const hex = (cx: number, cy: number): void => {
        g.beginPath()
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i
          const x = cx + s * Math.cos(a)
          const y = cy + s * Math.sin(a)
          if (i === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        }
        g.closePath()
        g.stroke()
      }
      hex(0, 0)
      hex(w, 0)
      hex(0, h)
      hex(w, h)
      hex(w / 2, h / 2)
      hexTile = ctx.createPattern(c, 'repeat')
    }

    const resize = (): void => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = container.clientWidth
      height = container.clientHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      keepOut.x = width / 2
      keepOut.y = height * 0.42
      keepOut.rx = Math.min(360, width * 0.32)
      keepOut.ry = Math.min(220, height * 0.3)
      washGrad = ctx.createRadialGradient(
        width / 2,
        height * 0.1,
        0,
        width / 2,
        height * 0.1,
        Math.max(width, height) * 1.05
      )
      washGrad.addColorStop(0, palette.wash[0])
      washGrad.addColorStop(1, palette.wash[1])
      vignetteGrad = ctx.createRadialGradient(
        width / 2,
        height / 2,
        Math.min(width, height) * 0.35,
        width / 2,
        height / 2,
        Math.hypot(width, height) * 0.6
      )
      vignetteGrad.addColorStop(0, 'rgba(0,0,0,0)')
      vignetteGrad.addColorStop(1, 'rgba(0,0,0,1)')
      buildHexTile()
      if (!traces.length) seedInitial()
      // Repaint immediately whenever the loop isn't running (reduced motion
      // or paused), so a resize never leaves a blank canvas behind.
      if (!raf) drawFrame(true)
    }

    // ------------------------------------------------------------ draw
    const tracePath = (tr: Trace): void => {
      ctx.beginPath()
      ctx.moveTo(tr.pts[0].x, tr.pts[0].y)
      for (let i = 1; i < tr.pts.length; i++) ctx.lineTo(tr.pts[i].x, tr.pts[i].y)
      if (tr.state === 'growing') ctx.lineTo(tr.head.x, tr.head.y)
    }

    const drawVia = (
      p: TracePoint,
      col: Rgb,
      alpha: number,
      isChip: boolean,
      flash: number
    ): void => {
      ctx.globalAlpha = Math.min(1, alpha * (0.7 + flash))
      ctx.strokeStyle = rgba(col, 1)
      ctx.fillStyle = rgba(col, 1)
      if (isChip) {
        // Tiny IC footprint: square outline + pin stubs.
        const s = 7
        ctx.lineWidth = 1.1
        ctx.strokeRect(p.x - s, p.y - s, s * 2, s * 2)
        ctx.beginPath()
        for (let i = -1; i <= 1; i++) {
          ctx.moveTo(p.x - s - 3, p.y + i * 4)
          ctx.lineTo(p.x - s, p.y + i * 4)
          ctx.moveTo(p.x + s, p.y + i * 4)
          ctx.lineTo(p.x + s + 3, p.y + i * 4)
        }
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(p.x, p.y, 1.6 + flash * 2, 0, Math.PI * 2)
        ctx.fill()
      } else {
        ctx.lineWidth = 1.1
        ctx.beginPath()
        ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2)
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(p.x, p.y, 0.9 + flash * 2, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    const drawTraces = (): void => {
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      for (const tr of traces) {
        if (tr.pts.length < 2 && tr.state !== 'growing') continue
        const col = rampAt(palette.ramp, tr.hue)
        const layerMul = tr.layer === 0 ? 0.5 : 1
        const base = tr.alpha * layerMul

        // Glow pass, then crisp core pass.
        ctx.globalCompositeOperation = palette.glowBlend
        ctx.globalAlpha = Math.min(1, base * (palette.glowAlpha + tr.highlight * 0.22))
        ctx.strokeStyle = rgba(col, 1)
        ctx.lineWidth = tr.w * 4.5
        tracePath(tr)
        ctx.stroke()
        ctx.globalCompositeOperation = 'source-over'

        ctx.globalAlpha = Math.min(1, base * (palette.coreAlpha + tr.highlight * 0.4))
        ctx.lineWidth = tr.w
        tracePath(tr)
        ctx.stroke()

        // Pads: start always, end once finished.
        drawVia(tr.pts[0], col, base, tr.chip, tr.endFlash)
        if (tr.state === 'alive' || tr.state === 'fading') {
          drawVia(tr.pts[tr.pts.length - 1], col, base, false, tr.endFlash)
        }
        // Etch-head glint while growing or being routed.
        if (tr.state === 'growing' || tr.state === 'routing') {
          ctx.globalCompositeOperation = palette.glowBlend
          ctx.globalAlpha = 0.9
          ctx.drawImage(haloSprite, tr.head.x - 8, tr.head.y - 8, 16, 16)
          ctx.globalCompositeOperation = 'source-over'
        }
        tr.endFlash *= 0.94
        tr.highlight *= 0.9
      }
      ctx.globalAlpha = 1
    }

    const drawPackets = (): void => {
      ctx.globalCompositeOperation = palette.glowBlend
      ctx.lineCap = 'round'
      for (let k = packets.length - 1; k >= 0; k--) {
        const p = packets[k]
        if (p.tr.state === 'fading' && p.tr.alpha < 0.4) {
          packets.splice(k, 1)
          continue
        }
        p.dist += p.speed * p.dir
        const total = traceLength(p.tr)
        if (p.dist <= 0 || p.dist >= total) {
          p.tr.endFlash = 1
          if (Math.random() < 0.45) spawnPacket(p.tr, p.dir === 1)
          packets.splice(k, 1)
          continue
        }
        const head = pointAt(p.tr, p.dist)
        const tail = pointAt(p.tr, Math.max(0, Math.min(total, p.dist - 34 * p.dir)))
        // Trail follows the actual polyline between tail and head.
        ctx.strokeStyle = rgba(p.col, palette.packetAlpha * 0.5 * p.tr.alpha)
        ctx.lineWidth = 1.6
        ctx.beginPath()
        ctx.moveTo(tail.x, tail.y)
        const lo = Math.min(tail.idx, head.idx)
        const hi = Math.max(tail.idx, head.idx)
        if (p.dir === 1) {
          for (let i = lo + 1; i <= hi; i++) ctx.lineTo(p.tr.pts[i].x, p.tr.pts[i].y)
        } else {
          for (let i = hi; i > lo; i--) ctx.lineTo(p.tr.pts[i].x, p.tr.pts[i].y)
        }
        ctx.lineTo(head.x, head.y)
        ctx.stroke()
        ctx.globalAlpha = palette.packetAlpha * p.tr.alpha
        ctx.drawImage(haloSprite, head.x - 7, head.y - 7, 14, 14)
        ctx.globalAlpha = 1
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    const drawSparks = (): void => {
      ctx.globalCompositeOperation = palette.glowBlend
      for (let k = sparks.length - 1; k >= 0; k--) {
        const s = sparks[k]
        s.x += s.vx
        s.y += s.vy
        s.life -= s.decay
        if (s.life <= 0) {
          sparks.splice(k, 1)
          continue
        }
        ctx.globalAlpha = s.life * s.life
        ctx.fillStyle = rgba(s.col, 1)
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.r * s.life, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }

    const drawBlooms = (): void => {
      for (let k = blooms.length - 1; k >= 0; k--) {
        const b = blooms[k]
        b.r += b.v
        b.alpha *= 0.94
        if (b.alpha < 0.02) {
          blooms.splice(k, 1)
          continue
        }
        ctx.globalAlpha = b.alpha * 0.6
        ctx.strokeStyle = rgba(palette.ramp[1], 1)
        ctx.lineWidth = 1.3
        ctx.beginPath()
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }

    const drawProbe = (): void => {
      if (!probe.inside) return
      // Nearest committed trace point; a coarse every-other-point scan is
      // plenty at these point counts.
      let best: TracePoint | null = null
      let bestD = 70
      for (const tr of traces) {
        if (tr.alpha < 0.5) continue
        for (let i = 0; i < tr.pts.length; i += 2) {
          const p = tr.pts[i]
          const d = Math.hypot(p.x - probe.x, p.y - probe.y)
          if (d < bestD) {
            bestD = d
            best = p
            if (tr.highlight < 0.6) tr.highlight = 0.6
          }
        }
      }
      ctx.globalCompositeOperation = palette.glowBlend
      ctx.globalAlpha = palette.halo
      ctx.drawImage(haloSprite, probe.x - 130, probe.y - 130, 260, 260)
      if (best && Math.random() < 0.85) {
        // Jittery two-segment arc — the probe "sparking" to the trace.
        const midX = (probe.x + best.x) / 2 + (Math.random() - 0.5) * 10
        const midY = (probe.y + best.y) / 2 + (Math.random() - 0.5) * 10
        ctx.globalAlpha = 0.25 + Math.random() * 0.3
        ctx.strokeStyle = rgba(palette.ramp[0], 1)
        ctx.lineWidth = 0.9
        ctx.beginPath()
        ctx.moveTo(probe.x, probe.y)
        ctx.lineTo(midX, midY)
        ctx.lineTo(best.x, best.y)
        ctx.stroke()
      }
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }

    const drawFrame = (staticFrame: boolean): void => {
      frame++
      ctx.clearRect(0, 0, width, height)
      if (washGrad) {
        ctx.fillStyle = washGrad
        ctx.fillRect(0, 0, width, height)
      }
      if (hexTile) {
        ctx.fillStyle = hexTile
        ctx.fillRect(0, 0, width, height)
      }

      // Lifecycle
      for (let k = traces.length - 1; k >= 0; k--) {
        const tr = traces[k]
        if (tr.state === 'growing') stepGrowth(tr)
        if (tr.state === 'alive' && frame > tr.fadeAt) tr.state = 'fading'
        if (tr.state === 'fading') {
          tr.alpha -= 0.006
          if (tr.alpha <= 0) {
            traces.splice(k, 1)
            continue
          }
        }
      }

      drawTraces()
      drawPackets()
      drawSparks()
      drawBlooms()
      drawProbe()

      if (palette.vignette > 0 && vignetteGrad) {
        ctx.globalAlpha = palette.vignette
        ctx.fillStyle = vignetteGrad
        ctx.fillRect(0, 0, width, height)
        ctx.globalAlpha = 1
      }

      if (staticFrame) return

      if (frame >= nextAutoAt) {
        autoSpawn()
        nextAutoAt = frame + 12 + Math.random() * 22
      }
      if (frame >= nextPacketAt) {
        const alive = traces.filter((t) => t.state === 'alive')
        if (alive.length) {
          spawnPacket(alive[(Math.random() * alive.length) | 0], Math.random() < 0.5)
        }
        nextPacketAt = frame + 14 + Math.random() * 26
      }
    }

    // ------------------------------------------------------------ loop
    const loop = (): void => {
      drawFrame(false)
      raf = requestAnimationFrame(loop)
    }
    const startLoop = (): void => {
      if (!raf && !staticOnly) raf = requestAnimationFrame(loop)
    }
    const stopLoop = (): void => {
      cancelAnimationFrame(raf)
      raf = 0
    }

    /** Grow the board without rendering — used for the reduced-motion still. */
    const growInstantly = (): void => {
      for (let i = 0; i < 900; i++) {
        frame++
        for (const tr of traces) if (tr.state === 'growing') stepGrowth(tr)
        if (frame >= nextAutoAt) {
          autoSpawn()
          nextAutoAt = frame + 20
        }
      }
    }

    const regrow = (): void => {
      playerTrace = null
      packets.length = 0
      if (staticOnly) {
        traces = []
        seedInitial()
        growInstantly()
        drawFrame(true)
        return
      }
      for (const tr of traces) tr.state = 'fading'
      window.clearTimeout(reseedTimer)
      reseedTimer = window.setTimeout(() => {
        seedInitial()
        if (!raf) drawFrame(true)
      }, 600)
    }

    const applyPalette = (): void => {
      palette = PALETTES[resolveDark() ? 'dark' : 'light']
      haloSprite = glowSprite(palette.ramp[1], 64)
      // The wash gradient and hex tile bake palette colors, so rebuild them.
      resize()
    }

    const onSchemeChange = (): void => {
      if (themeMode === 'system') applyPalette()
    }
    const onVisibilityChange = (): void => {
      if (document.hidden) stopLoop()
      else if (!pausedRef.current) startLoop()
    }

    setRunningRef.current = (running) => {
      if (running) startLoop()
      else stopLoop()
    }
    regrowRef.current = regrow

    resize()
    if (staticOnly) {
      growInstantly()
      drawFrame(true)
    } else if (pausedRef.current) {
      drawFrame(true)
    } else {
      startLoop()
    }

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    systemDark.addEventListener('change', onSchemeChange)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      stopLoop()
      window.clearTimeout(reseedTimer)
      setRunningRef.current = null
      regrowRef.current = null
      resizeObserver.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      systemDark.removeEventListener('change', onSchemeChange)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [reducedMotion, themeMode])

  const togglePause = (): void => {
    const nextPaused = !pausedRef.current
    pausedRef.current = nextPaused
    setPaused(nextPaused)
    setRunningRef.current?.(!nextPaused)
  }

  return (
    <>
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.controlButton}
          onClick={() => regrowRef.current?.()}
          title="Fade the board out and grow a fresh circuit"
        >
          Regrow
        </button>
        <button
          type="button"
          className={styles.controlButton}
          onClick={togglePause}
          disabled={motionDisabled}
          title={motionDisabled ? 'Motion is off (reduced motion)' : 'Pause or resume the scene'}
        >
          {paused ? 'Play' : 'Pause'}
        </button>
      </div>
    </>
  )
}
