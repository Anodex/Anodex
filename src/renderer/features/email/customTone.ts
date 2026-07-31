/**
 * Making a colour the reader picked safe to actually draw.
 *
 * Every other colour in Anodex comes from `theme.css` and has been checked
 * against both palettes. A custom sender colour cannot be — it is whatever
 * came out of the OS colour picker — so it has to be checked here instead.
 * Two failures matter and they pull in opposite directions: near-black is
 * invisible on the dark surface, near-white is invisible on the light one, and
 * the app does not know which theme a given reader will be in tomorrow.
 *
 * So the hue and saturation the reader chose are kept and only the *luminance*
 * is moved, into a band that reads on both surfaces. HSL lightness is not good
 * enough for this: pure yellow sits at 50% lightness and is still nearly
 * invisible on an off-white page, because lightness is not brightness. The
 * band below is in WCAG relative luminance, which is.
 */

import type { CSSProperties } from 'react'

export interface Rgb {
  r: number
  g: number
  b: number
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * The luminance band a sender colour is allowed to occupy.
 *
 * Derived, not chosen by eye. The bar is WCAG 1.4.11 non-text contrast, 3:1 —
 * the right standard here because the monogram is `aria-hidden` decoration
 * sitting beside the sender's name in real text, so it identifies rather than
 * informs. Solving 3:1 against the darkest surface (#111111) gives the floor
 * and against the lightest (#f9f8f5) gives the ceiling, with a little room
 * either side. `customTone.test.ts` re-derives both from the surfaces, so
 * these stay honest if the palettes move.
 */
export const MIN_LUMINANCE = 0.13
export const MAX_LUMINANCE = 0.27

/** How much of the colour shows behind the monogram. */
const BACKGROUND_ALPHA = 0.16

export function parseHex(value: string): Rgb | null {
  const match = HEX_RE.exec(value.trim())
  if (!match) return null
  const digits = match[1]
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : digits
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16)
  }
}

export function toHex({ r, g, b }: Rgb): string {
  const channel = (value: number): string =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

/** sRGB 0–255 to the linear-light 0–1 the luminance formula is defined on. */
function toLinear(channel: number): number {
  const scaled = channel / 255
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

function fromLinear(channel: number): number {
  const clamped = Math.min(1, Math.max(0, channel))
  const scaled = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055
  return scaled * 255
}

/** WCAG relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

export function contrastRatio(left: Rgb, right: Rgb): number {
  const a = luminance(left)
  const b = luminance(right)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/**
 * The nearest version of this colour that lands inside the readable band.
 *
 * Too bright is scaled down, which preserves hue and saturation exactly. Too
 * dark is blended towards white, which does desaturate — but a colour that
 * dark has to lighten somehow, and blending is the way that keeps its hue.
 */
export function legible(rgb: Rgb): Rgb {
  const current = luminance(rgb)
  const linear = { r: toLinear(rgb.r), g: toLinear(rgb.g), b: toLinear(rgb.b) }

  if (current > MAX_LUMINANCE) {
    const scale = MAX_LUMINANCE / current
    return {
      r: fromLinear(linear.r * scale),
      g: fromLinear(linear.g * scale),
      b: fromLinear(linear.b * scale)
    }
  }

  if (current < MIN_LUMINANCE) {
    // Luminance is linear in a linear-space blend, so the exact mix is known
    // rather than found by stepping towards it.
    const t = (MIN_LUMINANCE - current) / (1 - current)
    const mix = (channel: number): number => fromLinear(channel + t * (1 - channel))
    return { r: mix(linear.r), g: mix(linear.g), b: mix(linear.b) }
  }

  return rgb
}

/** The readable form of a picked colour, or null when it isn't a colour. */
export function legibleHex(value: string): string | null {
  const parsed = parseHex(value)
  return parsed ? toHex(legible(parsed)) : null
}

/**
 * The two custom properties `.avatar` reads. Returned as inline style because
 * the value is per-sender data rather than a design decision — this is the one
 * place in the view where a colour does not come from a token.
 */
export function customAvatarStyle(value: string): CSSProperties | undefined {
  const parsed = parseHex(value)
  if (!parsed) return undefined
  const safe = legible(parsed)
  return {
    '--avatar-fg': toHex(safe),
    '--avatar-bg': `rgba(${Math.round(safe.r)}, ${Math.round(safe.g)}, ${Math.round(safe.b)}, ${BACKGROUND_ALPHA})`
  } as CSSProperties
}
