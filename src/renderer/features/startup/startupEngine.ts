/**
 * Canvas engine for the startup overlay: a drifting deep-space field that, on
 * real readiness, inhales toward the Anodex mark and tears into a hyperspace
 * tunnel. Pure DOM/canvas — no React. The component owns the store wiring and
 * calls `launch()` / `fail()` / `resume()`; the engine owns the frame loop and
 * reflects its phase onto the stage element via `data-state` / `data-complete`
 * attributes (which React never touches, so re-renders can't wipe them).
 *
 * The field is POLAR: stars live as (angle, radius, depth), spawn on an
 * annulus, and are culled on a circle. Every contraction and recycle happens
 * in polar space, so no rectangular geometry exists to reveal — the old
 * square-spawn "box" artifact is impossible by construction.
 *
 * Phase time is frame-accumulated rather than wall-clock so a hidden window
 * (minimised launch) pauses the sequence instead of skipping to the end.
 */

export interface StartupEngineOptions {
  stage: HTMLElement
  starCanvas: HTMLCanvasElement
  /** Sits above the fading stage: the stardust carried into the app. */
  settleCanvas: HTMLCanvasElement
  isFirstLaunch: () => boolean
  isReducedMotion: () => boolean
  /** The sequence (or calm dismissal) fully finished — unmount the overlay. */
  onFinished: () => void
}

type EnginePhase = 'arrive' | 'drift' | 'charge' | 'jump' | 'out' | 'error' | 'off'

const ARRIVE_MS = 1000 // dropping out of warp: light dies, mark resolves
const MIN_DRIFT_MS = 500 // floor so an instant hydrate still reads as a scene
const FIRST_LAUNCH_MIN_DRIFT_MS = 2000 // first run gets a longer establishing beat
const CHARGE_MS = 760 // the inhale: stars spiral into the mark
const JUMP_RAMP_MS = 1000 // acceleration to full warp (logo chase runs in CSS)
const WARP_HOLD_MS = 500 // riding the tunnel at peak
const JUMP_TAIL_MS = 420 // deceleration before the field goes quiet
const OUT_MS = 1200 // stardust settles over the revealed app
const COMPLETE_LEAD_MS = 150 // start the overlay fade this long before hold ends
const CALM_FADE_MS = 600 // reduced-motion / recovery crossfade
const DRIFT_SPEED = 0.05 // z-units per second while initialising
const ARRIVE_SPEED = 2.2 // entry speed that dies away as the mark resolves
const JUMP_SPEED = 4.2 // peak z-units per second at full warp

const TAU = Math.PI * 2
const R_HOLE = 0.14 // hole kept around the mark
const R_MAX = 2.4 // outer rim parked well past the screen corners
const CULL_MARGIN = 150

const STAR_TONES: ReadonlyArray<readonly [number, number, number]> = [
  [240, 244, 255],
  [172, 196, 255],
  [124, 150, 255],
  [154, 128, 255],
  [255, 240, 214] // rare warm stars for photographic realism
]

interface Star {
  a: number
  r: number
  z: number
  size: number
  depth: number
  twinkle: number
  phaseSeed: number
  glint: boolean
  tone: readonly [number, number, number]
  fade: number
  px: number | null
  py: number | null
}

interface Comet {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  ttl: number
}

/** Bright radial light-streak that sells the tunnel at warp. */
interface Hero {
  a: number
  r0: number
  len: number
  v: number
  life: number
  ttl: number
  w: number
}

interface Mote {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  ttl: number
  size: number
  tone: readonly [number, number, number]
}

export class StartupEngine {
  private readonly opts: StartupEngineOptions
  private readonly starCtx: CanvasRenderingContext2D
  private readonly settleCtx: CanvasRenderingContext2D

  private phase: EnginePhase = 'off'
  private phaseElapsed = 0
  private readyRequested = false
  private completeMarked = false
  private width = 0
  private height = 0
  private speed = DRIFT_SPEED
  private wander = 1
  private roll = 0 // camera roll while riding the tunnel
  private fieldAlpha = 0
  private calmLevel = 1 // nebula presence: full in quiet phases, gone at warp
  private lastTime = 0
  private rafId = 0
  private calmTimer: ReturnType<typeof setTimeout> | undefined
  private camX = 0
  private camY = 0
  private mouseX = 0
  private mouseY = 0
  private stars: Star[] = []
  private dust: Star[] = []
  private comets: Comet[] = []
  private heroes: Hero[] = []
  private motes: Mote[] = []
  private nebula: HTMLCanvasElement | null = null

  private readonly handleResize = (): void => this.resize()
  private readonly handlePointerMove = (event: PointerEvent): void => {
    this.mouseX = Math.max(-1, Math.min(1, (event.clientX / this.width - 0.5) * 2))
    this.mouseY = Math.max(-1, Math.min(1, (event.clientY / this.height - 0.5) * 2))
  }
  private readonly frame = (now: number): void => this.tick(now)

  constructor(opts: StartupEngineOptions) {
    this.opts = opts
    const starCtx = opts.starCanvas.getContext('2d')
    const settleCtx = opts.settleCanvas.getContext('2d')
    if (!starCtx || !settleCtx) throw new Error('Startup overlay could not create a 2D context.')
    this.starCtx = starCtx
    this.settleCtx = settleCtx
    window.addEventListener('resize', this.handleResize)
    window.addEventListener('pointermove', this.handlePointerMove)
    this.resize()
  }

  /** Begin the arrival beat and the frame loop. */
  start(): void {
    this.phase = 'arrive'
    this.phaseElapsed = 0
    this.camX = this.width / 2
    this.camY = this.height / 2
    this.speed = this.opts.isReducedMotion() ? 0 : ARRIVE_SPEED
    this.setState(this.opts.isReducedMotion() ? 'drifting' : 'arriving')
    this.rafId = requestAnimationFrame(this.frame)
  }

  /** Real readiness arrived — jump once the minimum drift beat has played. */
  launch(): void {
    if (this.phase === 'off' || this.phase === 'out') return
    if (this.opts.isReducedMotion()) {
      this.calmFinish()
      return
    }
    this.readyRequested = true
  }

  /** Hydration failed — settle the field and hold for the recovery actions. */
  fail(): void {
    if (this.phase !== 'arrive' && this.phase !== 'drift') return
    this.phase = 'error'
    this.phaseElapsed = 0
    this.setState('error')
  }

  /** Retry began — bring the field back to life from the error state. */
  resume(): void {
    if (this.phase !== 'error') return
    this.phase = 'drift'
    this.phaseElapsed = 0
    this.readyRequested = false
    this.speed = this.opts.isReducedMotion() ? 0 : DRIFT_SPEED
    this.setState('drifting')
  }

  /** Crossfade out without the jump (reduced motion, or exiting via recovery). */
  calmFinish(): void {
    if (this.calmTimer) return
    this.opts.stage.dataset['complete'] = ''
    this.calmTimer = setTimeout(() => this.opts.onFinished(), CALM_FADE_MS)
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId)
    if (this.calmTimer) clearTimeout(this.calmTimer)
    window.removeEventListener('resize', this.handleResize)
    window.removeEventListener('pointermove', this.handlePointerMove)
    this.phase = 'off'
  }

  private setState(state: string): void {
    this.opts.stage.dataset['state'] = state
  }

  private minDrift(): number {
    return this.opts.isFirstLaunch() ? FIRST_LAUNCH_MIN_DRIFT_MS : MIN_DRIFT_MS
  }

  /* ---------- Polar field construction ---------- */

  /** Even areal density across the annulus (sqrt), hole preserved. */
  private spawnRing(star: Star, rMin: number, rMax: number): void {
    star.a = Math.random() * TAU
    star.r = Math.sqrt(rMin * rMin + Math.random() * (rMax * rMax - rMin * rMin))
  }

  private respawn(star: Star, anyDepth: boolean): void {
    this.spawnRing(star, R_HOLE, R_MAX)
    star.z = anyDepth ? 0.12 + Math.random() * 0.87 : 0.82 + Math.random() * 0.18
    star.depth = Math.random()
    star.twinkle = 0.8 + Math.random() * 2.2
    star.phaseSeed = Math.random() * 40
    star.fade = 1
    star.px = null
    star.py = null
  }

  /** Warp recycling biases radius inward so the tunnel core stays dense. */
  private respawnWarp(star: Star): void {
    star.a = Math.random() * TAU
    star.r = R_HOLE + (1.2 - R_HOLE) * Math.pow(Math.random(), 1.7)
    star.z = 0.84 + Math.random() * 0.16
    star.depth = Math.random()
    star.fade = 1
    star.px = null
    star.py = null
  }

  /**
   * During the inhale, consumed stars re-enter at a RANDOM radius across the
   * whole annulus (not at a fixed rim) and fade in. The ensemble density stays
   * stationary while every individual star spirals inward — so the field never
   * develops a visible contracting edge (no box, no donut).
   */
  private respawnCharge(star: Star): void {
    this.spawnRing(star, 0.5, R_MAX)
    star.z = 0.2 + Math.random() * 0.7
    star.fade = 0
    star.px = null
    star.py = null
  }

  private recycle(star: Star): void {
    if (this.phase === 'jump') this.respawnWarp(star)
    else this.respawn(star, false)
  }

  private makeStar(near: boolean): Star {
    const star: Star = {
      a: 0,
      r: 0,
      z: 0,
      size: near ? 0.7 + Math.random() * 1.5 : 0.25 + Math.random() * 0.6,
      depth: 0,
      twinkle: 0,
      phaseSeed: 0,
      glint: near && Math.random() < 0.08,
      tone: Math.random() < 0.06 ? STAR_TONES[4] : STAR_TONES[Math.floor(Math.random() * 4)],
      fade: 1,
      px: null,
      py: null
    }
    this.respawn(star, true)
    return star
  }

  private resize(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    this.width = window.innerWidth
    this.height = window.innerHeight
    for (const canvas of [this.opts.starCanvas, this.opts.settleCanvas]) {
      canvas.width = Math.floor(this.width * ratio)
      canvas.height = Math.floor(this.height * ratio)
    }
    this.starCtx.setTransform(ratio, 0, 0, ratio, 0, 0)
    this.settleCtx.setTransform(ratio, 0, 0, ratio, 0, 0)
    const area = this.width * this.height
    this.stars = Array.from({ length: Math.min(720, Math.floor(area / 1500)) }, () =>
      this.makeStar(true)
    )
    this.dust = Array.from({ length: Math.min(540, Math.floor(area / 2100)) }, () =>
      this.makeStar(false)
    )
    this.heroes = []
    this.buildNebula()
  }

  /* ---------- Phase machine ---------- */

  private transition(next: EnginePhase, state?: string): void {
    this.phase = next
    this.phaseElapsed = 0
    if (state) this.setState(state)
    // Kill stale trail anchors so no streak spans a phase cut
    for (const s of this.stars) {
      s.px = null
      s.py = null
    }
    for (const s of this.dust) {
      s.px = null
      s.py = null
    }
    // The inhale swallowed the field into the core — reseed the whole annulus
    // the instant the jump begins so the tunnel is born full-frame. The flare
    // ignition and shockwave cover the reseed completely.
    if (next === 'jump') {
      for (const s of this.stars) this.respawn(s, true)
      for (const s of this.dust) this.respawn(s, true)
    }
  }

  private updatePhase(dt: number): void {
    this.phaseElapsed += dt * 1000
    const t = this.phaseElapsed
    const reduced = this.opts.isReducedMotion()

    if (this.phase === 'arrive') {
      const p = Math.min(t / ARRIVE_MS, 1)
      this.speed = reduced ? 0 : ARRIVE_SPEED * Math.pow(1 - p, 2.4) + DRIFT_SPEED * p
      this.wander = p // sway eases in as the camera settles
      if (p >= 1) this.transition('drift', 'drifting')
    } else if (this.phase === 'drift') {
      this.speed = reduced ? 0 : DRIFT_SPEED
      this.wander = 1
      if (this.readyRequested && t >= this.minDrift()) this.transition('charge', 'charging')
    } else if (this.phase === 'charge') {
      const p = Math.min(t / CHARGE_MS, 1)
      this.speed = DRIFT_SPEED * (1 - p) + 0.004 * p
      this.wander = 1 - p
      if (p >= 1) this.transition('jump', 'jumping')
    } else if (this.phase === 'jump') {
      const p = Math.min(t / JUMP_RAMP_MS, 1)
      // Cubic ramp: still a violent tear at the end, but the tunnel is
      // visibly moving by a third of the way in — no dead-black lull.
      this.speed = 0.006 + Math.pow(p, 3) * JUMP_SPEED
      this.wander = 0
      if (!this.completeMarked && t >= JUMP_RAMP_MS + WARP_HOLD_MS - COMPLETE_LEAD_MS) {
        this.completeMarked = true
        this.opts.stage.dataset['complete'] = ''
        this.spawnMotes()
      }
      if (t >= JUMP_RAMP_MS + WARP_HOLD_MS + JUMP_TAIL_MS) this.transition('out')
    } else if (this.phase === 'out') {
      this.speed *= Math.pow(0.05, dt)
      if (t >= OUT_MS) {
        this.phase = 'off'
        this.settleCtx.clearRect(0, 0, this.width, this.height)
        this.opts.onFinished()
        return
      }
    } else if (this.phase === 'error') {
      this.speed *= Math.pow(0.03, dt) // stars coast to a stop
      if (this.speed < 0.0008) this.speed = 0
    }

    // Backdrop calm: full in quiet phases, gone at warp
    const calmTarget =
      this.phase === 'charge' || this.phase === 'jump' || this.phase === 'out' ? 0.12 : 1
    this.calmLevel += (calmTarget - this.calmLevel) * Math.min(1, dt * 3)

    // Camera roll: the tunnel banks as you ride it
    if (this.phase === 'jump') {
      this.roll += dt * (0.1 + 0.4 * Math.min(this.phaseElapsed / JUMP_RAMP_MS, 1))
    } else if (this.phase === 'out') {
      this.roll += dt * 0.08
    } else {
      this.roll = 0
    }
  }

  /* ---------- Pre-rendered nebula backdrop (drawn with parallax) ---------- */

  private buildNebula(): void {
    const size = Math.ceil(Math.max(this.width, this.height) * 1.5)
    if (size <= 0) return
    const off = document.createElement('canvas')
    off.width = size
    off.height = size
    const octx = off.getContext('2d')
    if (!octx) return

    const blob = (x: number, y: number, radius: number, rgb: string, alpha: number): void => {
      const grad = octx.createRadialGradient(x, y, 0, x, y, radius)
      grad.addColorStop(0, `rgba(${rgb}, ${alpha})`)
      grad.addColorStop(1, `rgba(${rgb}, 0)`)
      octx.fillStyle = grad
      octx.fillRect(x - radius, y - radius, radius * 2, radius * 2)
    }

    // Galactic band across the diagonal
    octx.save()
    octx.translate(size / 2, size / 2)
    octx.rotate(-0.48)
    const band = octx.createLinearGradient(0, -size * 0.16, 0, size * 0.16)
    band.addColorStop(0, 'rgba(120, 140, 220, 0)')
    band.addColorStop(0.5, 'rgba(120, 140, 220, 0.05)')
    band.addColorStop(1, 'rgba(120, 140, 220, 0)')
    octx.fillStyle = band
    octx.fillRect(-size, -size * 0.2, size * 2, size * 0.4)
    octx.restore()

    // Brand-hued clouds, fixed art-directed layout
    blob(size * 0.66, size * 0.32, size * 0.3, '124, 92, 255', 0.085)
    blob(size * 0.3, size * 0.68, size * 0.34, '79, 140, 255', 0.07)
    blob(size * 0.56, size * 0.74, size * 0.24, '56, 189, 248', 0.05)
    blob(size * 0.22, size * 0.26, size * 0.2, '168, 85, 247', 0.045)
    blob(size * 0.82, size * 0.6, size * 0.26, '36, 52, 130', 0.09)

    // Baked micro-stars: the far layer that barely moves
    for (let i = 0; i < 420; i++) {
      const a = Math.random() * TAU
      const r = (size / 2) * Math.sqrt(Math.random())
      const x = size / 2 + Math.cos(a) * r
      const y = size / 2 + Math.sin(a) * r
      octx.fillStyle = `rgba(226, 234, 255, ${(0.08 + Math.random() * 0.3).toFixed(3)})`
      const s = 0.4 + Math.random() * 0.9
      octx.fillRect(x, y, s, s)
    }

    this.nebula = off
  }

  private drawNebula(now: number): void {
    if (!this.nebula) return
    const level = this.calmLevel * this.fieldAlpha
    if (level <= 0.02) return
    const ctx = this.starCtx
    const t = now / 1000
    const size = this.nebula.width
    const w = this.width
    const h = this.height

    ctx.save()
    ctx.globalAlpha = level
    // Far layer: slow rotation + drift
    ctx.translate(w / 2 + Math.sin(t * 0.021) * 14, h / 2 + Math.cos(t * 0.017) * 10)
    ctx.rotate(Math.sin(t * 0.006) * 0.05)
    ctx.drawImage(this.nebula, -size / 2, -size / 2)
    ctx.restore()

    // Near layer: same texture, larger + counter-drifting = cheap parallax
    ctx.save()
    ctx.globalAlpha = level * 0.5
    ctx.translate(w / 2 - Math.sin(t * 0.014) * 26, h / 2 - Math.cos(t * 0.019) * 18)
    ctx.rotate(-Math.sin(t * 0.005) * 0.06)
    ctx.scale(1.35, 1.35)
    ctx.drawImage(this.nebula, -size / 2, -size / 2)
    ctx.restore()
  }

  /* ---------- Starfield ---------- */

  private drawLayer(
    list: Star[],
    now: number,
    dt: number,
    cx: number,
    cy: number,
    speedFactor: number,
    alphaFactor: number
  ): void {
    const ctx = this.starCtx
    const charging = this.phase === 'charge'
    const streaking = this.speed > 0.16 || charging
    const chargeP = charging ? Math.min(this.phaseElapsed / CHARGE_MS, 1) : 0
    const fovMix = Math.min(Math.max((this.speed - 0.6) / 3, 0), 1)
    const focal = this.height * (0.9 + 0.28 * fovMix)
    const speedMix = Math.min(this.speed / 2.4, 1) * 0.5
    const chromatic = this.speed > 1.2
    const cullR = Math.hypot(this.width, this.height) * 0.5 + CULL_MARGIN

    for (const star of list) {
      if (charging) {
        // The inhale, in pure polar math: swirl the angle, shrink the radius.
        // Contraction is a perfect circle — nothing rectangular exists to reveal.
        const pull = (1.2 + 1.1 * chargeP) * speedFactor
        star.a += (0.9 + 1.6 * chargeP) * dt
        star.r *= Math.max(0, 1 - pull * dt)
        if (star.r < 0.12) this.respawnCharge(star)
      } else {
        star.z -= this.speed * speedFactor * (0.85 + star.depth * 0.3) * dt
        if (star.z <= 0.015) this.recycle(star)
      }

      const k = focal / star.z
      const ca = star.a + this.roll
      const x = cx + Math.cos(ca) * star.r * k
      const y = cy + Math.sin(ca) * star.r * k

      // Circular cull only — recycling happens on a ring past the corners
      if (Math.hypot(x - this.width / 2, y - this.height / 2) > cullR) {
        if (!charging) this.recycle(star)
        star.px = null
        star.py = null
        continue
      }

      star.fade = Math.min(1, star.fade + dt * 2.6)

      const closeness = Math.min((1 - star.z) * 1.5, 1)
      let alpha = this.fieldAlpha * alphaFactor * (0.22 + closeness * 0.7) * star.fade
      if (!streaking) {
        alpha *= 0.78 + 0.22 * Math.sin((now / 1000) * star.twinkle * 2 + star.phaseSeed)
      }
      if (charging) alpha *= 0.95

      const r = Math.round(star.tone[0] + (255 - star.tone[0]) * speedMix)
      const g = Math.round(star.tone[1] + (255 - star.tone[1]) * speedMix)
      const b = Math.max(star.tone[2], 240)
      const size = Math.min(Math.max(star.size * closeness * 2, 0.35), 2.8)

      if (streaking) {
        if (star.px !== null && star.py !== null) {
          // Per-frame motion during the inhale is small — stretch the trail
          // behind the star so the spiral reads as light being drawn in
          let tx = star.px
          let ty = star.py
          if (charging) {
            tx = x + (star.px - x) * (2.5 + 3.5 * chargeP)
            ty = y + (star.py - y) * (2.5 + 3.5 * chargeP)
          }
          if (chromatic) {
            // Anamorphic hyperspace: violet + cyan fringes offset
            // perpendicular to motion under a white-blue core
            const dx = x - tx
            const dy = y - ty
            const len = Math.hypot(dx, dy) || 1
            const o = Math.min(2.4, (this.speed / JUMP_SPEED) * 2.6)
            const nx = (-dy / len) * o
            const ny = (dx / len) * o
            ctx.lineCap = 'round'
            ctx.strokeStyle = `rgba(154, 120, 255, ${(alpha * 0.3).toFixed(3)})`
            ctx.lineWidth = size * 2
            ctx.beginPath()
            ctx.moveTo(tx + nx, ty + ny)
            ctx.lineTo(x + nx, y + ny)
            ctx.stroke()
            ctx.strokeStyle = `rgba(110, 210, 255, ${(alpha * 0.22).toFixed(3)})`
            ctx.lineWidth = size * 1.4
            ctx.beginPath()
            ctx.moveTo(tx - nx, ty - ny)
            ctx.lineTo(x - nx, y - ny)
            ctx.stroke()
          }
          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(alpha, 0.6).toFixed(3)})`
          ctx.lineWidth = size
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.moveTo(tx, ty)
          ctx.lineTo(x, y)
          ctx.stroke()
        }
      } else {
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`
        ctx.beginPath()
        ctx.arc(x, y, size * 0.75, 0, TAU)
        ctx.fill()

        if (star.glint && closeness > 0.55) {
          const reach = 3 + closeness * 4
          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${(alpha * 0.4).toFixed(3)})`
          ctx.lineWidth = 0.6
          ctx.beginPath()
          ctx.moveTo(x - reach, y)
          ctx.lineTo(x + reach, y)
          ctx.moveTo(x, y - reach)
          ctx.lineTo(x, y + reach)
          ctx.stroke()
        }
      }

      star.px = x
      star.py = y
    }
  }

  /* ---------- Hero streaks: a few brilliant lines that sell the tunnel ---------- */

  private updateHeroes(dt: number): void {
    const ctx = this.starCtx
    if (this.phase === 'jump') {
      const p = Math.min(this.phaseElapsed / JUMP_RAMP_MS, 1)
      if (this.heroes.length < 15 && Math.random() < dt * (4 + 26 * p)) {
        this.heroes.push({
          a: Math.random() * TAU,
          r0: 0.04 + Math.random() * 0.18,
          len: 0.22 + Math.random() * 0.5,
          v: 2.4 + Math.random() * 2.2,
          life: 0,
          ttl: 0.32 + Math.random() * 0.26,
          w: 1 + Math.random() * 1.8
        })
      }
    }
    if (!this.heroes.length) return

    const base = Math.hypot(this.width, this.height) * 0.5
    for (const s of this.heroes) {
      s.life += dt
      s.r0 += s.v * dt
      const fade = Math.sin(Math.min(s.life / s.ttl, 1) * Math.PI)
      const ca = s.a + this.roll
      const dx = Math.cos(ca)
      const dy = Math.sin(ca)
      const x0 = this.width / 2 + dx * s.r0 * base
      const y0 = this.height / 2 + dy * s.r0 * base
      const x1 = this.width / 2 + dx * (s.r0 + s.len) * base
      const y1 = this.height / 2 + dy * (s.r0 + s.len) * base
      const grad = ctx.createLinearGradient(x0, y0, x1, y1)
      grad.addColorStop(0, 'rgba(140, 170, 255, 0)')
      grad.addColorStop(0.7, `rgba(170, 195, 255, ${(0.28 * fade).toFixed(3)})`)
      grad.addColorStop(1, `rgba(240, 246, 255, ${(0.75 * fade).toFixed(3)})`)
      ctx.strokeStyle = grad
      ctx.lineWidth = s.w
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.stroke()
    }
    this.heroes = this.heroes.filter((s) => s.life < s.ttl && s.r0 < 2.6)
  }

  /* ---------- Central bloom at warp ---------- */

  private drawBloom(): void {
    const sn = Math.min(this.speed / JUMP_SPEED, 1)
    if (sn < 0.22 || (this.phase !== 'jump' && this.phase !== 'out')) return
    const ctx = this.starCtx
    const radius = Math.min(this.width, this.height) * (0.1 + 0.42 * sn)
    const grad = ctx.createRadialGradient(
      this.width / 2,
      this.height / 2,
      0,
      this.width / 2,
      this.height / 2,
      radius
    )
    grad.addColorStop(0, `rgba(235, 242, 255, ${(0.3 * sn * this.fieldAlpha).toFixed(3)})`)
    grad.addColorStop(0.4, `rgba(140, 172, 255, ${(0.14 * sn * this.fieldAlpha).toFixed(3)})`)
    grad.addColorStop(1, 'rgba(124, 92, 255, 0)')
    ctx.fillStyle = grad
    ctx.fillRect(this.width / 2 - radius, this.height / 2 - radius, radius * 2, radius * 2)
  }

  /* ---------- Rare shooting stars while idling ---------- */

  private updateComets(dt: number): void {
    const ctx = this.starCtx
    if (
      this.phase === 'drift' &&
      !this.opts.isReducedMotion() &&
      this.comets.length < 2 &&
      Math.random() < dt * 0.25
    ) {
      const edge = Math.random() * TAU
      const dir = edge + Math.PI + (Math.random() - 0.5) * 1.2
      this.comets.push({
        x: this.width / 2 + Math.cos(edge) * this.width * 0.42,
        y: this.height / 2 + Math.sin(edge) * this.height * 0.42,
        vx: Math.cos(dir) * 850,
        vy: Math.sin(dir) * 850,
        life: 0,
        ttl: 0.5
      })
    }

    for (const comet of this.comets) {
      comet.life += dt
      comet.x += comet.vx * dt
      comet.y += comet.vy * dt
      const fade = Math.sin(Math.min(comet.life / comet.ttl, 1) * Math.PI)
      ctx.strokeStyle = `rgba(205, 218, 255, ${(0.4 * fade * this.fieldAlpha).toFixed(3)})`
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(comet.x - comet.vx * 0.09, comet.y - comet.vy * 0.09)
      ctx.lineTo(comet.x, comet.y)
      ctx.stroke()
    }
    this.comets = this.comets.filter((c) => c.life < c.ttl)
  }

  /* ---------- Stardust carried through the door ---------- */

  private spawnMotes(): void {
    if (this.opts.isReducedMotion()) return
    for (let i = 0; i < 34; i++) {
      const dir = Math.random() * TAU
      const v = 240 + Math.random() * 440
      this.motes.push({
        x: this.width / 2,
        y: this.height / 2,
        vx: Math.cos(dir) * v,
        vy: Math.sin(dir) * v,
        life: 0,
        ttl: 0.7 + Math.random() * 0.6,
        size: 0.8 + Math.random() * 1.6,
        tone: STAR_TONES[Math.floor(Math.random() * STAR_TONES.length)]
      })
    }
  }

  private updateMotes(dt: number): void {
    const ctx = this.settleCtx
    ctx.clearRect(0, 0, this.width, this.height)
    if (!this.motes.length) return
    ctx.globalCompositeOperation = 'lighter'
    for (const mote of this.motes) {
      mote.life += dt
      const decel = Math.pow(0.22, dt)
      mote.vx *= decel
      mote.vy *= decel
      mote.x += mote.vx * dt
      mote.y += mote.vy * dt
      const fade = Math.max(0, 1 - mote.life / mote.ttl)
      ctx.fillStyle = `rgba(${mote.tone[0]}, ${mote.tone[1]}, 255, ${(0.85 * fade).toFixed(3)})`
      ctx.beginPath()
      ctx.arc(mote.x, mote.y, mote.size * (0.6 + fade * 0.4), 0, TAU)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
    this.motes = this.motes.filter((m) => m.life < m.ttl)
  }

  /* ---------- Frame loop ---------- */

  private tick(now: number): void {
    const dt = this.lastTime ? Math.min((now - this.lastTime) / 1000, 0.05) : 0.016
    this.lastTime = now

    this.updatePhase(dt)
    if (this.phase === 'off') return // finished mid-update

    this.fieldAlpha = Math.min(this.fieldAlpha + dt * 2.4, 1)

    const ctx = this.starCtx
    const streaking = this.speed > 0.16 || this.phase === 'charge'
    if (this.speed > 0.5) {
      // translucent clear leaves light-trail persistence at warp
      ctx.fillStyle = 'rgba(5, 6, 10, 0.28)'
      ctx.fillRect(0, 0, this.width, this.height)
    } else {
      ctx.clearRect(0, 0, this.width, this.height)
    }

    this.drawNebula(now)

    // camera: idle sway + mouse parallax, dead-centre once the jump begins
    const t = now / 1000
    const sway = this.wander * (this.opts.isReducedMotion() ? 0 : 1)
    const targetX =
      this.width / 2 +
      ((Math.sin(t * 0.13) * 0.012 + Math.sin(t * 0.07 + 2) * 0.008) * this.width +
        this.mouseX * 0.022 * this.width) *
        sway
    const targetY =
      this.height / 2 +
      ((Math.cos(t * 0.11) * 0.01 + Math.sin(t * 0.06 + 4) * 0.007) * this.height +
        this.mouseY * 0.018 * this.height) *
        sway
    this.camX += (targetX - this.camX) * Math.min(1, dt * 3)
    this.camY += (targetY - this.camY) * Math.min(1, dt * 3)

    if (streaking) ctx.globalCompositeOperation = 'lighter'
    this.drawLayer(this.dust, now, dt, this.camX, this.camY, 0.45, 0.55)
    this.drawLayer(this.stars, now, dt, this.camX, this.camY, 1, 1)
    this.updateHeroes(dt)
    this.drawBloom()
    ctx.globalCompositeOperation = 'source-over'

    this.updateComets(dt)
    this.updateMotes(dt)

    this.rafId = requestAnimationFrame(this.frame)
  }
}
