/**
 * Canvas engine for the startup overlay: a drifting deep-space field that, on
 * real readiness, inhales toward the Anodex mark and tears into a hyperspace
 * tunnel. Pure DOM/canvas — no React. The component owns the store wiring and
 * calls `launch()` / `fail()` / `resume()`; the engine owns the frame loop and
 * reflects its phase onto the stage element via `data-state` / `data-complete`
 * attributes (which React never touches, so re-renders can't wipe them).
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

const ARRIVE_MS = 700 // dropping out of warp: light dies, mark resolves
const MIN_DRIFT_MS = 500 // floor so an instant hydrate still reads as a scene
const FIRST_LAUNCH_MIN_DRIFT_MS = 2000 // first run gets a longer establishing beat
const CHARGE_MS = 600 // the inhale: stars spiral into the mark
const JUMP_RAMP_MS = 950 // acceleration to full warp (logo chase runs in CSS)
const WARP_HOLD_MS = 450 // riding the tunnel at peak
const JUMP_TAIL_MS = 380 // deceleration before the field goes quiet
const OUT_MS = 1200 // stardust settles over the revealed app
const COMPLETE_LEAD_MS = 120 // start the overlay fade this long before hold ends
const CALM_FADE_MS = 600 // reduced-motion / recovery crossfade
const DRIFT_SPEED = 0.055 // z-units per second while initialising
const JUMP_SPEED = 3.8 // peak z-units per second at full warp

const STAR_TONES: ReadonlyArray<readonly [number, number, number]> = [
  [240, 244, 255],
  [172, 196, 255],
  [124, 150, 255],
  [154, 128, 255],
  [255, 240, 214] // rare warm stars for photographic realism
]

interface Star {
  x: number
  y: number
  z: number
  size: number
  depth: number
  twinkle: number
  phaseSeed: number
  glint: boolean
  tone: readonly [number, number, number]
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
  private fieldAlpha = 0
  private auroraLevel = 1
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
  private motes: Mote[] = []

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

  /* ---------- Field construction ---------- */

  private respawn(star: Star, anyDepth: boolean): void {
    let x = 0
    let y = 0
    do {
      x = (Math.random() * 2 - 1) * 1.3
      y = (Math.random() * 2 - 1) * 1.3
    } while (Math.hypot(x, y) < 0.16) // keep a hole around the mark

    star.x = x
    star.y = y
    star.z = anyDepth ? 0.12 + Math.random() * 0.88 : 0.82 + Math.random() * 0.18
    star.depth = Math.random()
    star.twinkle = 0.8 + Math.random() * 2.2
    star.phaseSeed = Math.random() * 40
    star.px = null
    star.py = null
  }

  private respawnAtRim(star: Star): void {
    const angle = Math.random() * Math.PI * 2
    const radius = 1.05 + Math.random() * 0.3
    star.x = Math.cos(angle) * radius
    star.y = Math.sin(angle) * radius
    star.z = 0.2 + Math.random() * 0.7
    star.px = null
    star.py = null
  }

  private makeStar(near: boolean): Star {
    const star: Star = {
      x: 0,
      y: 0,
      z: 0,
      size: near ? 0.7 + Math.random() * 1.5 : 0.25 + Math.random() * 0.6,
      depth: 0,
      twinkle: 0,
      phaseSeed: 0,
      glint: near && Math.random() < 0.08,
      tone: Math.random() < 0.06 ? STAR_TONES[4] : STAR_TONES[Math.floor(Math.random() * 4)],
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
    this.stars = Array.from({ length: Math.min(340, Math.floor(area / 4000)) }, () =>
      this.makeStar(true)
    )
    this.dust = Array.from({ length: Math.min(300, Math.floor(area / 4600)) }, () =>
      this.makeStar(false)
    )
  }

  /* ---------- Phase machine ---------- */

  private updatePhase(dt: number): void {
    this.phaseElapsed += dt * 1000
    const t = this.phaseElapsed

    if (this.phase === 'arrive') {
      this.speed = this.opts.isReducedMotion() ? 0 : DRIFT_SPEED
      this.wander = 1
      if (t >= ARRIVE_MS) {
        this.phase = 'drift'
        this.phaseElapsed = 0
        this.setState('drifting')
      }
    } else if (this.phase === 'drift') {
      this.speed = this.opts.isReducedMotion() ? 0 : DRIFT_SPEED
      this.wander = 1
      if (this.readyRequested && t >= this.minDrift()) {
        this.phase = 'charge'
        this.phaseElapsed = 0
        this.setState('charging')
      }
    } else if (this.phase === 'charge') {
      const p = Math.min(t / CHARGE_MS, 1)
      this.speed = DRIFT_SPEED * (1 - p) + 0.004 * p
      this.wander = 1 - p
      if (p >= 1) {
        this.phase = 'jump'
        this.phaseElapsed = 0
        this.setState('jumping')
      }
    } else if (this.phase === 'jump') {
      const p = Math.min(t / JUMP_RAMP_MS, 1)
      const eased = p === 0 ? 0 : Math.pow(2, 10 * p - 10)
      this.speed = 0.006 + eased * JUMP_SPEED
      this.wander = 0
      if (!this.completeMarked && t >= JUMP_RAMP_MS + WARP_HOLD_MS - COMPLETE_LEAD_MS) {
        this.completeMarked = true
        this.opts.stage.dataset['complete'] = ''
        this.spawnMotes()
      }
      if (t >= JUMP_RAMP_MS + WARP_HOLD_MS + JUMP_TAIL_MS) {
        this.phase = 'out'
        this.phaseElapsed = 0
      }
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

    const auroraTarget =
      this.phase === 'charge' || this.phase === 'jump' || this.phase === 'out' ? 0.2 : 1
    this.auroraLevel += (auroraTarget - this.auroraLevel) * Math.min(1, dt * 3)
  }

  /* ---------- Backdrop: galactic band + aurora haze ---------- */

  private nebulaBlob(x: number, y: number, radius: number, rgb: string, alpha: number): void {
    if (alpha <= 0.003) return
    const grad = this.starCtx.createRadialGradient(x, y, 0, x, y, radius)
    grad.addColorStop(0, `rgba(${rgb}, ${alpha.toFixed(3)})`)
    grad.addColorStop(1, `rgba(${rgb}, 0)`)
    this.starCtx.fillStyle = grad
    this.starCtx.fillRect(x - radius, y - radius, radius * 2, radius * 2)
  }

  private drawBackdrop(now: number): void {
    const level = this.auroraLevel * this.fieldAlpha
    if (level <= 0.02) return
    const ctx = this.starCtx
    const t = now / 1000
    const w = this.width
    const h = this.height
    const base = Math.min(w, h)

    ctx.save()
    ctx.translate(w / 2, h / 2)
    ctx.rotate(-0.48)
    const drift = Math.sin(t * 0.02) * h * 0.06
    const band = ctx.createLinearGradient(0, -h * 0.26 + drift, 0, h * 0.26 + drift)
    band.addColorStop(0, 'rgba(120, 140, 220, 0)')
    band.addColorStop(0.5, `rgba(120, 140, 220, ${(0.032 * level).toFixed(3)})`)
    band.addColorStop(1, 'rgba(120, 140, 220, 0)')
    ctx.fillStyle = band
    ctx.fillRect(-w, -h * 0.3 + drift, w * 2, h * 0.6)
    ctx.restore()

    this.nebulaBlob(
      w * 0.66 + Math.sin(t * 0.05) * 32,
      h * 0.34 + Math.cos(t * 0.04) * 26,
      base * 0.52,
      '124, 92, 255',
      0.055 * level
    )
    this.nebulaBlob(
      w * 0.32 + Math.cos(t * 0.037) * 36,
      h * 0.68 + Math.sin(t * 0.045) * 28,
      base * 0.58,
      '79, 140, 255',
      0.045 * level
    )
    this.nebulaBlob(
      w * 0.55 + Math.sin(t * 0.028 + 2) * 40,
      h * 0.72 + Math.cos(t * 0.033 + 1) * 24,
      base * 0.42,
      '56, 189, 248',
      0.03 * level
    )
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
    const fov = 0.92 + 0.16 * Math.min(Math.max((this.speed - 0.8) / 2.8, 0), 1)
    const focal = this.height * fov
    const speedMix = Math.min(this.speed / 2.4, 1) * 0.5
    const chromatic = this.speed > 1.1

    for (const star of list) {
      if (charging) {
        // the inhale: space contracts toward the mark with a slight spiral
        const pull = 1.55 * dt * speedFactor
        const swirl = 0.85 * dt
        const nx = star.x * Math.cos(swirl) - star.y * Math.sin(swirl)
        const ny = star.x * Math.sin(swirl) + star.y * Math.cos(swirl)
        star.x = nx * (1 - pull)
        star.y = ny * (1 - pull)
        if (Math.hypot(star.x, star.y) < 0.12) this.respawnAtRim(star)
      } else {
        star.z -= this.speed * speedFactor * (0.85 + star.depth * 0.3) * dt
        if (star.z <= 0.015) this.respawn(star, false)
      }

      const k = focal / star.z
      const x = cx + star.x * k
      const y = cy + star.y * k

      if (x < -80 || x > this.width + 80 || y < -80 || y > this.height + 80) {
        this.respawn(star, false)
        continue
      }

      const closeness = Math.min((1 - star.z) * 1.5, 1)
      let alpha = this.fieldAlpha * alphaFactor * (0.22 + closeness * 0.7)
      if (!streaking) {
        alpha *= 0.78 + 0.22 * Math.sin((now / 1000) * star.twinkle * 2 + star.phaseSeed)
      }
      if (charging) alpha *= 0.85

      const r = Math.round(star.tone[0] + (255 - star.tone[0]) * speedMix)
      const g = Math.round(star.tone[1] + (255 - star.tone[1]) * speedMix)
      const b = Math.max(star.tone[2], 240)
      const size = Math.min(Math.max(star.size * closeness * 2, 0.35), 2.8)

      if (streaking) {
        if (star.px !== null && star.py !== null) {
          if (chromatic) {
            // violet fringe under a white-blue core: anamorphic hyperspace
            ctx.strokeStyle = `rgba(154, 120, 255, ${(alpha * 0.3).toFixed(3)})`
            ctx.lineWidth = size * 2.2
            ctx.lineCap = 'round'
            ctx.beginPath()
            ctx.moveTo(star.px, star.py)
            ctx.lineTo(x, y)
            ctx.stroke()
          }
          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(alpha, 0.6).toFixed(3)})`
          ctx.lineWidth = size
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.moveTo(star.px, star.py)
          ctx.lineTo(x, y)
          ctx.stroke()
        }
      } else {
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`
        ctx.beginPath()
        ctx.arc(x, y, size * 0.75, 0, Math.PI * 2)
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

  /* ---------- Rare shooting stars while idling ---------- */

  private updateComets(dt: number): void {
    const ctx = this.starCtx
    if (
      this.phase === 'drift' &&
      !this.opts.isReducedMotion() &&
      this.comets.length < 2 &&
      Math.random() < dt * 0.25
    ) {
      const edge = Math.random() * Math.PI * 2
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
    for (let i = 0; i < 30; i++) {
      const dir = Math.random() * Math.PI * 2
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
      ctx.arc(mote.x, mote.y, mote.size * (0.6 + fade * 0.4), 0, Math.PI * 2)
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
      ctx.fillStyle = 'rgba(5, 6, 9, 0.28)'
      ctx.fillRect(0, 0, this.width, this.height)
    } else {
      ctx.clearRect(0, 0, this.width, this.height)
    }

    this.drawBackdrop(now)

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
    ctx.globalCompositeOperation = 'source-over'

    this.updateComets(dt)
    this.updateMotes(dt)

    this.rafId = requestAnimationFrame(this.frame)
  }
}
