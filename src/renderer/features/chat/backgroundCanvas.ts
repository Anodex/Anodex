/** Shared canvas helpers for the animated chat backgrounds
 *  (ChatConstellation "Neural Deep Field" and ChatCircuit "Silicon Bloom"). */

export type Rgb = [number, number, number]

export const rgba = (c: Rgb, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

export const mixColor = (a: Rgb, b: Rgb, t: number): Rgb => [
  lerp(a[0], b[0], t) | 0,
  lerp(a[1], b[1], t) | 0,
  lerp(a[2], b[2], t) | 0
]

/** Sample a three-stop color ramp at t ∈ [0, 1]. */
export const rampAt = (ramp: [Rgb, Rgb, Rgb], t: number): Rgb =>
  t < 0.5 ? mixColor(ramp[0], ramp[1], t * 2) : mixColor(ramp[1], ramp[2], (t - 0.5) * 2)

/** Pre-rendered radial-gradient glow sprite; far cheaper than shadowBlur. */
export function glowSprite(color: Rgb, size: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  if (!g) return c
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, rgba(color, 0.85))
  grad.addColorStop(0.35, rgba(color, 0.28))
  grad.addColorStop(1, rgba(color, 0))
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  return c
}
