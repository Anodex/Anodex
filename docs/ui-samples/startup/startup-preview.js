const canvas = document.querySelector('#starfield')
const context = canvas.getContext('2d')
const previewShell = document.querySelector('#previewShell')
const bootStage = document.querySelector('#bootStage')
const appReveal = document.querySelector('#appReveal')
const statusText = document.querySelector('#statusText')
const errorTitle = document.querySelector('#errorTitle')
const errorDetail = document.querySelector('#errorDetail')
const replayButton = document.querySelector('#replayButton')
const jumpButton = document.querySelector('#jumpButton')
const failButton = document.querySelector('#failButton')
const retryButton = document.querySelector('#retryButton')
const settingsButton = document.querySelector('#settingsButton')
const rmToggle = document.querySelector('#rmToggle')

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

const statusSteps = [
  'Starting local core',
  'Loading settings',
  'Restoring workspace',
  'Checking local models',
  'Opening Anodex'
]

const DRIFT_SPEED = 0.055 // z-units per second while initializing
const JUMP_SPEED = 3.6 // peak z-units per second at full warp
const IGNITE_MS = 280 // anticipation beat: stars nearly stop, mark primes
const CHASE_MS = 1300 // matches logoChase duration in CSS
const WARP_HOLD_MS = 450 // ride the tunnel at full speed after the mark is gone
const STATUS_INTERVAL_MS = 880
const AUTO_READY_MS = 4200

const STAR_TONES = [
  [240, 244, 255],
  [172, 196, 255],
  [124, 150, 255],
  [154, 128, 255]
]

let width = 0
let height = 0
let centerX = 0
let centerY = 0
let stars = []
let dust = []
let phase = 'off' // off | drift | ignite | jump | error
let phaseElapsed = 0 // frame-accumulated ms, so a hidden window pauses rather than skips
let bootCompleted = false
let speed = DRIFT_SPEED
let wander = 1 // camera sway weight; eases to 0 so the tunnel is dead-centre
let fieldAlpha = 0
let lastTime = 0
let rafId = 0
let statusTimer = 0
let statusIndex = 0
let pendingTimeouts = []

const reducedMotion = () => rmToggle.checked || prefersReducedMotion.matches

function later(fn, ms) {
  pendingTimeouts.push(window.setTimeout(fn, ms))
}

function clearPending() {
  pendingTimeouts.forEach(window.clearTimeout)
  pendingTimeouts = []
  window.clearInterval(statusTimer)
}

function respawn(star, anyDepth) {
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

function makeStar(near) {
  const star = {}
  respawn(star, true)
  star.size = near ? 0.7 + Math.random() * 1.5 : 0.25 + Math.random() * 0.6
  star.tone = STAR_TONES[Math.floor(Math.random() * STAR_TONES.length)]
  star.glint = near && Math.random() < 0.08
  return star
}

function resize() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  width = window.innerWidth
  height = window.innerHeight
  centerX = width / 2
  centerY = height / 2
  canvas.width = Math.floor(width * ratio)
  canvas.height = Math.floor(height * ratio)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  stars = Array.from({ length: Math.min(320, Math.floor((width * height) / 4200)) }, () =>
    makeStar(true)
  )
  dust = Array.from({ length: Math.min(300, Math.floor((width * height) / 4600)) }, () =>
    makeStar(false)
  )
}

function updatePhase(now, dt) {
  phaseElapsed += dt * 1000
  const t = phaseElapsed

  if (phase === 'drift') {
    speed = reducedMotion() ? 0 : DRIFT_SPEED
    wander = 1
  } else if (phase === 'ignite') {
    const p = Math.min(t / IGNITE_MS, 1)
    speed = DRIFT_SPEED + (0.006 - DRIFT_SPEED) * p
    wander = 1 - p
    if (p >= 1) {
      phase = 'jump'
      phaseElapsed = 0
      bootStage.classList.remove('is-igniting')
      bootStage.classList.add('is-jumping')
      appReveal.classList.add('is-visible')
    }
  } else if (phase === 'jump') {
    const p = Math.min(t / CHASE_MS, 1)
    const eased = p === 0 ? 0 : Math.pow(2, 10 * p - 10)
    speed = 0.006 + eased * JUMP_SPEED
    wander = 0
    if (!bootCompleted && t >= CHASE_MS + WARP_HOLD_MS - 100) {
      bootCompleted = true
      bootStage.classList.add('is-complete')
    }
    if (t >= CHASE_MS + WARP_HOLD_MS + 900) {
      phase = 'off'
    }
  } else if (phase === 'error') {
    speed *= Math.pow(0.03, dt) // stars coast to a stop
    if (speed < 0.0008) speed = 0
  }
}

function nebulaBlob(x, y, radius, rgb, alpha) {
  const grad = context.createRadialGradient(x, y, 0, x, y, radius)
  grad.addColorStop(0, `rgba(${rgb}, ${alpha.toFixed(3)})`)
  grad.addColorStop(1, `rgba(${rgb}, 0)`)
  context.fillStyle = grad
  context.fillRect(x - radius, y - radius, radius * 2, radius * 2)
}

function drawNebula(now) {
  const calm = Math.max(0, 1 - speed / 0.6) * fieldAlpha
  if (calm <= 0.02) return
  const t = now / 1000
  const base = Math.min(width, height)
  nebulaBlob(
    width * 0.64 + Math.sin(t * 0.05) * 30,
    height * 0.36 + Math.cos(t * 0.04) * 24,
    base * 0.55,
    '124, 92, 255',
    0.05 * calm
  )
  nebulaBlob(
    width * 0.34 + Math.cos(t * 0.037) * 34,
    height * 0.66 + Math.sin(t * 0.045) * 26,
    base * 0.6,
    '79, 140, 255',
    0.04 * calm
  )
}

function drawLayer(list, now, dt, cx, cy, options) {
  const streaking = speed > 0.16
  const focal = height * 0.92
  const speedMix = Math.min(speed / 2.4, 1) * 0.5

  for (const star of list) {
    star.z -= speed * options.speedFactor * (0.85 + star.depth * 0.3) * dt
    if (star.z <= 0.015) respawn(star, false)

    const k = focal / star.z
    const x = cx + star.x * k
    const y = cy + star.y * k

    if (x < -80 || x > width + 80 || y < -80 || y > height + 80) {
      respawn(star, false)
      continue
    }

    const closeness = Math.min((1 - star.z) * 1.5, 1)
    let alpha = fieldAlpha * options.alphaFactor * (0.22 + closeness * 0.7)
    if (!streaking) {
      alpha *= 0.78 + 0.22 * Math.sin((now / 1000) * star.twinkle * 2 + star.phaseSeed)
    }

    const r = Math.round(star.tone[0] + (255 - star.tone[0]) * speedMix)
    const g = Math.round(star.tone[1] + (255 - star.tone[1]) * speedMix)
    const size = Math.min(Math.max(star.size * closeness * 2, 0.35), 2.8)

    if (streaking) {
      if (star.px !== null) {
        context.strokeStyle = `rgba(${r}, ${g}, 255, ${Math.min(alpha, 0.6).toFixed(3)})`
        context.lineWidth = size
        context.lineCap = 'round'
        context.beginPath()
        context.moveTo(star.px, star.py)
        context.lineTo(x, y)
        context.stroke()
      }
    } else {
      context.fillStyle = `rgba(${r}, ${g}, 255, ${alpha.toFixed(3)})`
      context.beginPath()
      context.arc(x, y, size * 0.75, 0, Math.PI * 2)
      context.fill()

      if (star.glint && closeness > 0.55) {
        const reach = 3 + closeness * 4
        context.strokeStyle = `rgba(${r}, ${g}, 255, ${(alpha * 0.4).toFixed(3)})`
        context.lineWidth = 0.6
        context.beginPath()
        context.moveTo(x - reach, y)
        context.lineTo(x + reach, y)
        context.moveTo(x, y - reach)
        context.lineTo(x, y + reach)
        context.stroke()
      }
    }

    star.px = x
    star.py = y
  }
}

function frame(now) {
  const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0.016
  lastTime = now

  updatePhase(now, dt)
  fieldAlpha = Math.min(fieldAlpha + dt * 2.4, 1)

  const streaking = speed > 0.16
  if (speed > 0.5) {
    // translucent clear leaves light-trail persistence at warp
    context.fillStyle = 'rgba(5, 6, 9, 0.28)'
    context.fillRect(0, 0, width, height)
  } else {
    context.clearRect(0, 0, width, height)
  }

  drawNebula(now)

  // gentle camera sway while idling; dead-centre once the jump begins
  const t = now / 1000
  const sway = wander * (reducedMotion() ? 0 : 1)
  const cx = centerX + (Math.sin(t * 0.13) * 0.012 + Math.sin(t * 0.07 + 2) * 0.008) * width * sway
  const cy = centerY + (Math.cos(t * 0.11) * 0.01 + Math.sin(t * 0.06 + 4) * 0.007) * height * sway

  if (streaking) context.globalCompositeOperation = 'lighter'
  drawLayer(dust, now, dt, cx, cy, { speedFactor: 0.45, alphaFactor: 0.55 })
  drawLayer(stars, now, dt, cx, cy, { speedFactor: 1, alphaFactor: 1 })
  context.globalCompositeOperation = 'source-over'

  if (phase !== 'off') rafId = requestAnimationFrame(frame)
}

function setStatus(text) {
  const fadeOut = statusText.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 110,
    easing: 'ease-in',
    fill: 'forwards'
  })
  fadeOut.onfinish = () => {
    statusText.textContent = text
    statusText.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 170,
      easing: 'ease-out',
      fill: 'forwards'
    })
  }
}

function setStatusStep() {
  setStatus(statusSteps[statusIndex])
  statusIndex = Math.min(statusIndex + 1, statusSteps.length - 1)
}

function calmReveal() {
  clearPending()
  bootStage.classList.remove('is-igniting', 'is-jumping', 'is-error')
  bootStage.classList.add('is-complete')
  appReveal.classList.add('is-visible')
  later(() => {
    phase = 'off'
  }, 800)
}

function startJump() {
  if (phase !== 'drift') return
  clearPending()
  setStatus('Opening Anodex')

  if (reducedMotion()) {
    calmReveal()
    return
  }

  phase = 'ignite'
  phaseElapsed = 0
  bootStage.classList.add('is-igniting')
}

function enterError(title, detail) {
  if (phase !== 'drift') return
  clearPending()
  errorTitle.textContent = title
  errorDetail.textContent = detail
  phase = 'error'
  phaseElapsed = 0
  bootStage.classList.add('is-error')
}

function replay() {
  clearPending()
  window.cancelAnimationFrame(rafId)
  bootStage.classList.remove('is-igniting', 'is-jumping', 'is-complete', 'is-error')
  appReveal.classList.remove('is-visible')

  statusIndex = 0
  statusText.textContent = statusSteps[0]
  statusIndex = 1
  statusTimer = window.setInterval(setStatusStep, STATUS_INTERVAL_MS)
  later(startJump, AUTO_READY_MS)

  phase = 'drift'
  phaseElapsed = 0
  bootCompleted = false
  speed = reducedMotion() ? 0 : DRIFT_SPEED
  wander = 1
  fieldAlpha = 0
  lastTime = 0
  for (const star of stars) {
    star.px = null
    star.py = null
  }
  for (const star of dust) {
    star.px = null
    star.py = null
  }
  rafId = requestAnimationFrame(frame)
}

window.addEventListener('resize', resize)
replayButton.addEventListener('click', replay)
jumpButton.addEventListener('click', startJump)
failButton.addEventListener('click', () =>
  enterError("Couldn't restore your workspace", 'The conversation store didn’t respond in time.')
)
retryButton.addEventListener('click', replay)
settingsButton.addEventListener('click', calmReveal)
rmToggle.addEventListener('change', () => previewShell.classList.toggle('rm', rmToggle.checked))

resize()
replay()
