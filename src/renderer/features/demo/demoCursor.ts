/**
 * A drawn-on cursor for the demo driver. The driver clicks elements
 * programmatically, which moves no real pointer and reads as things happening
 * by themselves on a recording. This puts a visible pointer on screen and
 * glides it to each target first, so the video shows cause before effect.
 *
 * Dev-only, mounted and removed by the driver — nothing renders it in the app.
 */

/** Eased travel time, clamped so short hops still read as deliberate. */
const MIN_TRAVEL_MS = 260
const MAX_TRAVEL_MS = 900
/** Pixels per millisecond the glide aims for before clamping. */
const SPEED_PX_PER_MS = 1.9
/** Held on target before the click fires, so the viewer's eye lands first. */
const SETTLE_MS = 180

let cursor: HTMLDivElement | null = null
let position = { x: 0, y: 0 }

/** Cubic ease-in-out — accelerates off the mark and coasts into the target. */
function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

function frame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

/** Creates the pointer and parks it in the lower-left, off the working area. */
export function showCursor(): void {
  if (cursor) return
  cursor = document.createElement('div')
  cursor.dataset.demoCursor = 'true'
  cursor.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'width:22px',
    'height:22px',
    'z-index:2147483647',
    'pointer-events:none',
    'will-change:transform',
    'filter:drop-shadow(0 2px 4px rgba(0,0,0,0.45))'
  ].join(';')
  // Inline SVG rather than the OS cursor image: it has to be visible over both
  // themes, and a screen recorder composites the real cursor unpredictably.
  cursor.innerHTML = `
    <svg viewBox="0 0 22 22" width="22" height="22" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 2 L3 17 L7.2 13.2 L10 19.5 L12.6 18.3 L9.9 12.2 L15.5 12.2 Z"
            fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/>
    </svg>`
  document.body.appendChild(cursor)

  position = { x: 80, y: window.innerHeight - 120 }
  applyPosition()
}

export function hideCursor(): void {
  cursor?.remove()
  cursor = null
}

function applyPosition(scale = 1): void {
  if (!cursor) return
  cursor.style.transform = `translate(${position.x}px, ${position.y}px) scale(${scale})`
}

/** Glides the pointer to an absolute viewport point. */
export async function moveTo(x: number, y: number): Promise<void> {
  if (!cursor) return
  const from = { ...position }
  const distance = Math.hypot(x - from.x, y - from.y)
  const duration = Math.min(MAX_TRAVEL_MS, Math.max(MIN_TRAVEL_MS, distance / SPEED_PX_PER_MS))
  const start = performance.now()

  for (;;) {
    const now = await frame()
    const t = Math.min(1, (now - start) / duration)
    const eased = ease(t)
    position = { x: from.x + (x - from.x) * eased, y: from.y + (y - from.y) * eased }
    applyPosition()
    if (t >= 1) break
  }
}

/**
 * Glides to an element's centre, plays a small press animation, then clicks it.
 * Scrolls the element into view first — a pointer gliding to something offscreen
 * would land on nothing.
 */
export async function clickElement(el: HTMLElement): Promise<void> {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  await new Promise((resolve) => setTimeout(resolve, 220))

  const rect = el.getBoundingClientRect()
  await moveTo(rect.left + rect.width / 2, rect.top + rect.height / 2)
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))

  applyPosition(0.82)
  await new Promise((resolve) => setTimeout(resolve, 90))
  el.click()
  applyPosition(1)
}

/**
 * Glides to a field and focuses it, without the press animation — used before
 * typing, where the click itself isn't the point.
 */
export async function focusElement(el: HTMLElement): Promise<void> {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  await new Promise((resolve) => setTimeout(resolve, 220))
  const rect = el.getBoundingClientRect()
  // Sits just inside the left edge, where a text caret would be, rather than
  // dead centre over the text being typed.
  await moveTo(rect.left + Math.min(24, rect.width / 2), rect.top + rect.height / 2)
  el.focus()
}
