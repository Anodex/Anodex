import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { glowSprite, lerp, rampAt, rgba, type Rgb } from './backgroundCanvas'
import styles from './ChatBackground.module.css'

interface Node3D {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  r: number
  hue: number
  tw: number
  flash: number
  /** Screen-space spring offset driven by cursor gravity and shockwaves. */
  ox: number
  oy: number
  ovx: number
  ovy: number
  /** Per-frame projection cache. */
  sx: number
  sy: number
  scale: number
  fog: number
}

interface Link {
  i: number
  j: number
  d: number
}

interface Star {
  x: number
  y: number
  depth: number
  r: number
  tw: number
  twSpeed: number
}

interface NebulaBlob {
  sprite: number
  cx: number
  cy: number
  orbit: number
  speed: number
  phase: number
  size: number
}

interface Pulse {
  a: number
  b: number
  t: number
  sp: number
  hops: number
  hue: number
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

interface Wave {
  x: number
  y: number
  r: number
  v: number
  alpha: number
}

interface Meteor {
  x: number
  y: number
  vx: number
  vy: number
  life: number
}

interface ScenePalette {
  /** Node/link color ramp, cyan → blue → violet. */
  ramp: [Rgb, Rgb, Rgb]
  star: Rgb
  nebula: Rgb[]
  nebulaBlend: GlobalCompositeOperation
  nebulaAlpha: number
  glowBlend: GlobalCompositeOperation
  linkAlpha: number
  starAlpha: number
  vignette: number
  halo: number
  /** Radial ground wash drawn under everything, [inner, outer] rgba strings. */
  ground: [string, string]
}

/** Dark ramp is the original constellation palette; the light ramp is the
 *  same hues pulled darker so they hold contrast on the light surface. */
const PALETTES: Record<'dark' | 'light', ScenePalette> = {
  dark: {
    ramp: [
      [33, 233, 255],
      [79, 140, 255],
      [124, 92, 255]
    ],
    star: [205, 222, 255],
    nebula: [
      [33, 233, 255],
      [79, 140, 255],
      [124, 92, 255],
      [46, 84, 200]
    ],
    nebulaBlend: 'lighter',
    nebulaAlpha: 0.07,
    glowBlend: 'lighter',
    linkAlpha: 0.5,
    starAlpha: 0.85,
    vignette: 0.5,
    halo: 0.1,
    ground: ['rgba(16, 16, 26, 0.85)', 'rgba(12, 12, 12, 0)']
  },
  light: {
    ramp: [
      [14, 165, 201],
      [47, 111, 224],
      [104, 71, 209]
    ],
    star: [96, 116, 168],
    nebula: [
      [125, 211, 235],
      [147, 178, 245],
      [186, 160, 240],
      [160, 190, 250]
    ],
    nebulaBlend: 'source-over',
    nebulaAlpha: 0.22,
    glowBlend: 'source-over',
    linkAlpha: 0.34,
    starAlpha: 0.55,
    vignette: 0,
    halo: 0.09,
    ground: ['rgba(238, 242, 251, 0.9)', 'rgba(255, 255, 255, 0)']
  }
}

const DENSITY = 150 // nodes per 1440×900 of container, at 'balanced'
const LINK_DIST_3D = 0.3 // world units; lattice slab is 2.3 × 2 × 1.6
const FOV = 2.4
const MOUSE_RADIUS = 220
const MAX_PULSES = 140
const MAX_SPARKS = 380

const DENSITY_MODES = ['calm', 'balanced', 'dense'] as const
type DensityMode = (typeof DENSITY_MODES)[number]
const DENSITY_FACTOR: Record<DensityMode, number> = { calm: 0.6, balanced: 1, dense: 1.5 }
const DENSITY_LABEL: Record<DensityMode, string> = {
  calm: 'Calm',
  balanced: 'Balanced',
  dense: 'Dense'
}

/**
 * "Neural Deep Field" — the animated empty-state background. Successor to the
 * original flat node-and-link constellation: the lattice now lives in a slowly
 * rotating 3D slab (perspective + depth fog) over a parallax starfield,
 * drifting nebula haze, and occasional shooting stars, with glowing signal
 * pulses hopping node-to-node like the local model thinking.
 *
 * Interactive: moving the cursor tilts the field and bends nearby nodes
 * toward it (links around the cursor brighten), clicking empty space fires an
 * expanding shockwave that shoves nodes and cascades pulses through the
 * network, and dragging paints a fading trail of stardust. All input is
 * observed from window-level listeners with clicks gated to non-interactive
 * targets, so the canvas keeps `pointer-events: none` and never steals events
 * from real controls layered above it.
 *
 * Sized to its parent via ResizeObserver rather than the window, since it
 * lives inside the chat panel, not full-bleed. Mounted by `ChatView` directly
 * on the panel body (behind both the empty state and the composer, via
 * negative z-index) and only while the conversation is empty — unmounting
 * (chat starting) tears the animation down.
 *
 * Respects the existing Appearance > "Reduced motion" setting in addition to
 * the OS-level `prefers-reduced-motion` media query (this is a canvas loop,
 * which the app's blanket CSS reduced-motion rule can't touch) by rendering a
 * single static frame instead of animating. Follows the Appearance theme mode,
 * including live OS changes while in 'system' mode.
 *
 * Small pill controls in the panel's bottom-right corner cycle the node
 * density (Calm / Balanced / Dense) and pause/resume the animation; both are
 * per-session, not persisted.
 */
export function ChatConstellation(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const reducedMotion = useSettingsStore((s) => s.settings?.appearance.reducedMotion ?? false)
  const themeMode = useSettingsStore((s) => s.settings?.appearance.themeMode ?? 'dark')

  const [density, setDensity] = useState<DensityMode>('balanced')
  const [paused, setPaused] = useState(false)
  // The effect re-runs on density/theme changes; a ref (not the state) tells
  // the rebuilt scene whether to stay paused without re-running on toggle.
  const pausedRef = useRef(false)
  const setRunningRef = useRef<((running: boolean) => void) | null>(null)

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

    // ---------------------------------------------------------- sprites
    let nodeSprites: HTMLCanvasElement[] = []
    let starSprite: HTMLCanvasElement | null = null
    let nebulaSprites: HTMLCanvasElement[] = []

    const buildSprites = (): void => {
      nodeSprites = []
      for (let i = 0; i < 12; i++) nodeSprites.push(glowSprite(rampAt(palette.ramp, i / 11), 64))
      starSprite = glowSprite(palette.star, 32)
      nebulaSprites = palette.nebula.map((col) => {
        const c = document.createElement('canvas')
        c.width = c.height = 512
        const g = c.getContext('2d')
        if (!g) return c
        const grad = g.createRadialGradient(256, 256, 0, 256, 256, 256)
        grad.addColorStop(0, rgba(col, 0.9))
        grad.addColorStop(0.4, rgba(col, 0.32))
        grad.addColorStop(1, rgba(col, 0))
        g.fillStyle = grad
        g.fillRect(0, 0, 512, 512)
        return c
      })
    }

    // ------------------------------------------------------------ state
    let width = 0
    let height = 0
    let minDim = 0
    let dpr = 1
    let nodes: Node3D[] = []
    const links: Link[] = []
    let neighbors: number[][] = []
    let stars: Star[] = []
    let blobs: NebulaBlob[] = []
    const pulses: Pulse[] = []
    const sparks: Spark[] = []
    const waves: Wave[] = []
    let meteor: Meteor | null = null
    let groundGrad: CanvasGradient | null = null
    let vignetteGrad: CanvasGradient | null = null

    const mouse = { x: -9999, y: -9999, inside: false, down: false, moved: 0 }
    const par = { x: 0, y: 0 }
    let baseAngle = 0
    let tiltX = 0
    let tiltY = 0
    let frame = 0
    let nextMeteorAt = 400
    let nextFlareAt = 700
    let nextAmbientPulseAt = 60
    let raf = 0

    const makeNodes = (): void => {
      const count = Math.round((DENSITY * DENSITY_FACTOR[density] * width * height) / (1440 * 900))
      nodes = Array.from({ length: Math.max(50, count) }, () => ({
        x: (Math.random() * 2 - 1) * 1.15,
        y: (Math.random() * 2 - 1) * 1.0,
        z: (Math.random() * 2 - 1) * 0.8,
        vx: (Math.random() - 0.5) * 0.0012,
        vy: (Math.random() - 0.5) * 0.0012,
        vz: (Math.random() - 0.5) * 0.0008,
        r: 0.9 + Math.random() * 1.7,
        hue: Math.random(),
        tw: Math.random() * Math.PI * 2,
        flash: 0,
        ox: 0,
        oy: 0,
        ovx: 0,
        ovy: 0,
        sx: 0,
        sy: 0,
        scale: 1,
        fog: 1
      }))
    }

    const makeStars = (): void => {
      const count = Math.round((260 * width * height) / (1440 * 900))
      stars = Array.from({ length: count }, () => ({
        x: Math.random(),
        y: Math.random(),
        depth: 0.25 + Math.random() * 0.75,
        r: Math.random() < 0.12 ? 1.6 + Math.random() * 1.2 : 0.5 + Math.random() * 0.8,
        tw: Math.random() * Math.PI * 2,
        twSpeed: 0.008 + Math.random() * 0.03
      }))
    }

    const makeBlobs = (): void => {
      blobs = Array.from({ length: 6 }, (_, i) => ({
        sprite: i,
        cx: Math.random(),
        cy: Math.random(),
        orbit: 0.03 + Math.random() * 0.06,
        speed: 0.0006 + Math.random() * 0.0009,
        phase: Math.random() * Math.PI * 2,
        size: 0.4 + Math.random() * 0.45
      }))
    }

    const resize = (): void => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = container.clientWidth
      height = container.clientHeight
      minDim = Math.min(width, height)
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      groundGrad = ctx.createRadialGradient(
        width / 2,
        height * 0.08,
        0,
        width / 2,
        height * 0.08,
        Math.max(width, height) * 1.1
      )
      groundGrad.addColorStop(0, palette.ground[0])
      groundGrad.addColorStop(1, palette.ground[1])
      vignetteGrad = ctx.createRadialGradient(
        width / 2,
        height / 2,
        minDim * 0.35,
        width / 2,
        height / 2,
        Math.hypot(width, height) * 0.62
      )
      vignetteGrad.addColorStop(0, 'rgba(0,0,0,0)')
      vignetteGrad.addColorStop(1, 'rgba(0,0,0,1)')
      makeNodes()
      makeStars()
      if (!blobs.length) makeBlobs()
      // Repaint immediately whenever the loop isn't running (reduced motion
      // or paused), so a resize never leaves a blank canvas behind.
      if (!raf) drawFrame(true)
    }

    // ------------------------------------------------------- projection
    const project = (n: Node3D): void => {
      const cy = Math.cos(baseAngle + tiltX)
      const sy = Math.sin(baseAngle + tiltX)
      const cx = Math.cos(tiltY)
      const sx = Math.sin(tiltY)
      const xr = n.x * cy + n.z * sy
      let zr = -n.x * sy + n.z * cy
      const yr = n.y * cx - zr * sx
      zr = n.y * sx + zr * cx
      const persp = FOV / (FOV + zr)
      n.sx = width / 2 + xr * width * 0.42 * persp + n.ox
      n.sy = height / 2 + yr * height * 0.44 * persp + n.oy
      n.scale = persp
      n.fog = Math.max(0.22, Math.min(1, (persp - 0.55) / 0.85))
    }

    // --------------------------------------------------------- signals
    const spawnPulse = (i: number, hops: number): void => {
      const opts = neighbors[i]
      if (pulses.length > MAX_PULSES || !opts || opts.length === 0) return
      const j = opts[(Math.random() * opts.length) | 0]
      pulses.push({
        a: i,
        b: j,
        t: 0,
        sp: 0.014 + Math.random() * 0.012,
        hops,
        hue: nodes[i].hue,
        col: rampAt(palette.ramp, nodes[i].hue)
      })
    }

    const flareNode = (i: number, hops: number, count: number): void => {
      nodes[i].flash = Math.max(nodes[i].flash, 1.6)
      for (let k = 0; k < count; k++) spawnPulse(i, hops)
    }

    // ----------------------------------------------------------- input
    const toLocal = (event: PointerEvent): { x: number; y: number } => {
      const rect = container.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    /** True when the gesture began on a real control rather than dead space —
     *  those must keep their normal behavior, no background effects. */
    const onInteractiveTarget = (event: PointerEvent): boolean =>
      event.target instanceof Element &&
      event.target.closest('button, a, input, textarea, select, [role="button"]') !== null

    const onPointerMove = (event: PointerEvent): void => {
      const p = toLocal(event)
      if (mouse.down) {
        mouse.moved += Math.hypot(p.x - mouse.x, p.y - mouse.y)
        if (mouse.moved > 8) {
          for (let i = 0; i < 3; i++) {
            if (sparks.length > MAX_SPARKS) break
            const a = Math.random() * Math.PI * 2
            const sp = 0.3 + Math.random() * 1.6
            sparks.push({
              x: p.x + (Math.random() - 0.5) * 6,
              y: p.y + (Math.random() - 0.5) * 6,
              vx: Math.cos(a) * sp,
              vy: Math.sin(a) * sp - 0.2,
              life: 1,
              decay: 0.008 + Math.random() * 0.014,
              r: 0.8 + Math.random() * 1.8,
              col: rampAt(palette.ramp, Math.random())
            })
          }
        }
      }
      mouse.x = p.x
      mouse.y = p.y
      mouse.inside = p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (onInteractiveTarget(event)) return
      const p = toLocal(event)
      if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) return
      mouse.down = true
      mouse.moved = 0
      mouse.x = p.x
      mouse.y = p.y
    }

    const onPointerUp = (event: PointerEvent): void => {
      if (!mouse.down) return
      mouse.down = false
      if (mouse.moved > 8 || onInteractiveTarget(event)) return
      const p = toLocal(event)
      waves.push({ x: p.x, y: p.y, r: 6, v: 7.5, alpha: 0.9 })
      let fired = 0
      for (let i = 0; i < nodes.length && fired < 8; i++) {
        if (Math.hypot(nodes[i].sx - p.x, nodes[i].sy - p.y) < 190) {
          flareNode(i, 2, 2)
          fired++
        }
      }
    }

    // ------------------------------------------------------------ draw
    const drawNebula = (t: number): void => {
      ctx.globalCompositeOperation = palette.nebulaBlend
      for (const b of blobs) {
        const bx = (b.cx + Math.cos(t * b.speed + b.phase) * b.orbit) * width
        const by = (b.cy + Math.sin(t * b.speed * 0.8 + b.phase) * b.orbit) * height
        const s = minDim * b.size * 2.2
        ctx.globalAlpha = palette.nebulaAlpha
        ctx.drawImage(nebulaSprites[b.sprite % nebulaSprites.length], bx - s / 2, by - s / 2, s, s)
      }
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }

    const drawStars = (t: number): void => {
      if (!starSprite) return
      const px = par.x * 26
      const py = par.y * 26
      for (const s of stars) {
        const twinkle = 0.55 + 0.45 * Math.sin(s.tw + t * s.twSpeed)
        const x = s.x * width + px * s.depth
        const y = s.y * height + py * s.depth
        const a = palette.starAlpha * twinkle * (0.35 + s.depth * 0.65)
        if (s.r > 1.4) {
          ctx.globalAlpha = a
          const g = s.r * 9
          ctx.drawImage(starSprite, x - g / 2, y - g / 2, g, g)
        }
        ctx.globalAlpha = a
        ctx.fillStyle = rgba(palette.star, 1)
        ctx.beginPath()
        ctx.arc(x, y, s.r * (0.8 + 0.2 * twinkle), 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    const drawMeteor = (): void => {
      if (!meteor) return
      meteor.x += meteor.vx
      meteor.y += meteor.vy
      meteor.life -= 0.016
      if (meteor.life <= 0) {
        meteor = null
        return
      }
      const tail = 9
      const g = ctx.createLinearGradient(
        meteor.x,
        meteor.y,
        meteor.x - meteor.vx * tail,
        meteor.y - meteor.vy * tail
      )
      const a = Math.min(1, meteor.life * 2) * 0.8
      g.addColorStop(0, rgba(palette.star, a))
      g.addColorStop(1, rgba(palette.star, 0))
      ctx.globalCompositeOperation = palette.glowBlend
      ctx.strokeStyle = g
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.moveTo(meteor.x, meteor.y)
      ctx.lineTo(meteor.x - meteor.vx * tail, meteor.y - meteor.vy * tail)
      ctx.stroke()
      ctx.globalCompositeOperation = 'source-over'
    }

    const stepLattice = (): void => {
      for (const n of nodes) {
        n.x += n.vx
        n.y += n.vy
        n.z += n.vz
        if (n.x < -1.15 || n.x > 1.15) n.vx *= -1
        if (n.y < -1.0 || n.y > 1.0) n.vy *= -1
        if (n.z < -0.8 || n.z > 0.8) n.vz *= -1
        n.flash *= 0.94
        project(n)

        // Cursor gravity: a gentle lens that pulls nearby nodes.
        if (mouse.inside) {
          const dx = mouse.x - n.sx
          const dy = mouse.y - n.sy
          const d = Math.hypot(dx, dy)
          if (d < MOUSE_RADIUS && d > 0.001) {
            const f = 1 - d / MOUSE_RADIUS
            const pull = f * f * 1.15
            n.ovx += (dx / d) * pull
            n.ovy += (dy / d) * pull
          }
        }
        // Shockwave bands push outward as they pass.
        for (const w of waves) {
          const dx = n.sx - w.x
          const dy = n.sy - w.y
          const d = Math.hypot(dx, dy)
          const band = Math.abs(d - w.r)
          if (band < 46 && d > 0.001) {
            const imp = (1 - band / 46) * w.alpha * 2.6
            n.ovx += (dx / d) * imp
            n.ovy += (dy / d) * imp
            if (band < 18 && Math.random() < 0.04) n.flash = Math.max(n.flash, 0.9)
          }
        }
        // Spring back to the true projected position.
        n.ovx += -0.02 * n.ox
        n.ovy += -0.02 * n.oy
        n.ovx *= 0.86
        n.ovy *= 0.86
        n.ox += n.ovx
        n.oy += n.ovy
      }

      // Neighbor graph in 3D world space (stable under rotation).
      links.length = 0
      neighbors = nodes.map(() => [])
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const dz = a.z - b.z
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 < LINK_DIST_3D * LINK_DIST_3D) {
            links.push({ i, j, d: Math.sqrt(d2) })
            neighbors[i].push(j)
            neighbors[j].push(i)
          }
        }
      }
    }

    const drawLinks = (): void => {
      ctx.lineWidth = 0.9
      for (const l of links) {
        const a = nodes[l.i]
        const b = nodes[l.j]
        let alpha = (1 - l.d / LINK_DIST_3D) * palette.linkAlpha * Math.min(a.fog, b.fog)
        if (mouse.inside) {
          const md = Math.hypot((a.sx + b.sx) / 2 - mouse.x, (a.sy + b.sy) / 2 - mouse.y)
          if (md < 240) alpha = Math.min(1, alpha + (1 - md / 240) * 0.4)
        }
        alpha += (a.flash + b.flash) * 0.14
        if (alpha < 0.015) continue
        ctx.globalAlpha = Math.min(1, alpha)
        ctx.strokeStyle = rgba(rampAt(palette.ramp, (a.hue + b.hue) / 2), 1)
        ctx.beginPath()
        ctx.moveTo(a.sx, a.sy)
        ctx.lineTo(b.sx, b.sy)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }

    const drawPulses = (): void => {
      ctx.globalCompositeOperation = palette.glowBlend
      for (let k = pulses.length - 1; k >= 0; k--) {
        const p = pulses[k]
        const a = nodes[p.a]
        const b = nodes[p.b]
        p.t += p.sp
        if (p.t >= 1) {
          b.flash = Math.max(b.flash, 1.1)
          if (p.hops > 0 && Math.random() < 0.75) spawnPulse(p.b, p.hops - 1)
          pulses.splice(k, 1)
          continue
        }
        const x = lerp(a.sx, b.sx, p.t)
        const y = lerp(a.sy, b.sy, p.t)
        const t0 = Math.max(0, p.t - 0.16)
        const x0 = lerp(a.sx, b.sx, t0)
        const y0 = lerp(a.sy, b.sy, t0)
        const fog = Math.min(a.fog, b.fog)
        const g = ctx.createLinearGradient(x0, y0, x, y)
        g.addColorStop(0, rgba(p.col, 0))
        g.addColorStop(1, rgba(p.col, 0.85 * fog))
        ctx.strokeStyle = g
        ctx.lineWidth = 1.6
        ctx.beginPath()
        ctx.moveTo(x0, y0)
        ctx.lineTo(x, y)
        ctx.stroke()
        ctx.globalAlpha = 0.9 * fog
        const spr = nodeSprites[Math.min(11, Math.round(p.hue * 11))]
        ctx.drawImage(spr, x - 9, y - 9, 18, 18)
        ctx.globalAlpha = 1
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    const drawNodes = (t: number): void => {
      ctx.globalCompositeOperation = palette.glowBlend
      for (const n of nodes) {
        const twinkle = 0.8 + 0.2 * Math.sin(n.tw + t * 0.02)
        const r = n.r * n.scale * twinkle * (1 + n.flash * 0.9)
        const glow = r * 8 * (1 + n.flash)
        ctx.globalAlpha = n.fog * (0.5 + n.flash * 0.5)
        const spr = nodeSprites[Math.min(11, Math.round(n.hue * 11))]
        ctx.drawImage(spr, n.sx - glow / 2, n.sy - glow / 2, glow, glow)
        ctx.globalAlpha = n.fog
        ctx.fillStyle = rgba(rampAt(palette.ramp, n.hue), 1)
        ctx.beginPath()
        ctx.arc(n.sx, n.sy, r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }

    const drawWaves = (): void => {
      for (let k = waves.length - 1; k >= 0; k--) {
        const w = waves[k]
        w.r += w.v
        w.alpha *= 0.965
        if (w.alpha < 0.02) {
          waves.splice(k, 1)
          continue
        }
        ctx.globalAlpha = w.alpha * 0.55
        ctx.strokeStyle = rgba(palette.ramp[1], 1)
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(w.x, w.y, w.r, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = w.alpha * 0.2
        ctx.lineWidth = 7
        ctx.beginPath()
        ctx.arc(w.x, w.y, w.r * 0.92, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }

    const drawSparks = (): void => {
      ctx.globalCompositeOperation = palette.glowBlend
      for (let k = sparks.length - 1; k >= 0; k--) {
        const s = sparks[k]
        s.x += s.vx
        s.y += s.vy
        s.vx *= 0.985
        s.vy *= 0.985
        s.life -= s.decay
        if (s.life <= 0) {
          sparks.splice(k, 1)
          continue
        }
        const a = s.life * s.life
        const g = s.r * 7 * s.life
        ctx.globalAlpha = a * 0.9
        ctx.drawImage(nodeSprites[6], s.x - g / 2, s.y - g / 2, g, g)
        ctx.globalAlpha = a
        ctx.fillStyle = rgba(s.col, 1)
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.r * s.life, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }

    const drawHalo = (): void => {
      if (!mouse.inside || palette.halo <= 0) return
      ctx.globalCompositeOperation = palette.glowBlend
      ctx.globalAlpha = palette.halo
      const s = 340
      ctx.drawImage(nodeSprites[4], mouse.x - s / 2, mouse.y - s / 2, s, s)
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }

    const drawFrame = (staticFrame: boolean): void => {
      frame++
      const t = frame

      if (!staticFrame) {
        const tx = mouse.inside ? (mouse.x / width - 0.5) * 2 : 0
        const ty = mouse.inside ? (mouse.y / height - 0.5) * 2 : 0
        par.x += (tx - par.x) * 0.04
        par.y += (ty - par.y) * 0.04
        baseAngle += 0.00055
        tiltX += (par.x * 0.22 - tiltX) * 0.03
        tiltY += (par.y * 0.16 - tiltY) * 0.03
      }

      ctx.clearRect(0, 0, width, height)
      if (groundGrad) {
        ctx.fillStyle = groundGrad
        ctx.fillRect(0, 0, width, height)
      }
      drawNebula(t)
      drawStars(t)
      drawMeteor()
      stepLattice()
      drawLinks()
      drawPulses()
      drawNodes(t)
      drawWaves()
      drawSparks()
      drawHalo()
      if (palette.vignette > 0 && vignetteGrad) {
        ctx.globalAlpha = palette.vignette
        ctx.fillStyle = vignetteGrad
        ctx.fillRect(0, 0, width, height)
        ctx.globalAlpha = 1
      }

      if (staticFrame) return

      // Ambient life: signal chatter, meteors, occasional node flare.
      if (t >= nextAmbientPulseAt) {
        spawnPulse((Math.random() * nodes.length) | 0, 1 + ((Math.random() * 2) | 0))
        nextAmbientPulseAt = t + 26 + Math.random() * 50
      }
      if (t >= nextMeteorAt && !meteor) {
        const fromLeft = Math.random() < 0.5
        meteor = {
          x: fromLeft ? -30 : width + 30,
          y: Math.random() * height * 0.45,
          vx: (fromLeft ? 1 : -1) * (5 + Math.random() * 4),
          vy: 1.6 + Math.random() * 2,
          life: 1
        }
        nextMeteorAt = t + 420 + Math.random() * 600
      }
      if (t >= nextFlareAt) {
        flareNode((Math.random() * nodes.length) | 0, 3, 4)
        nextFlareAt = t + 700 + Math.random() * 800
      }
    }

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

    const applyPalette = (): void => {
      palette = PALETTES[resolveDark() ? 'dark' : 'light']
      buildSprites()
      // Ground/vignette gradients bake palette colors, so rebuild them too.
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

    buildSprites()
    resize()
    if (staticOnly || pausedRef.current) drawFrame(true)
    if (!staticOnly && !pausedRef.current) startLoop()

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    systemDark.addEventListener('change', onSchemeChange)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      stopLoop()
      setRunningRef.current = null
      resizeObserver.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      systemDark.removeEventListener('change', onSchemeChange)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [reducedMotion, themeMode, density])

  const cycleDensity = (): void => {
    setDensity((d) => DENSITY_MODES[(DENSITY_MODES.indexOf(d) + 1) % DENSITY_MODES.length])
  }

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
          onClick={cycleDensity}
          title="Cycle background density"
        >
          {DENSITY_LABEL[density]}
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
