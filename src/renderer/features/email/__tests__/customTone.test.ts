import { describe, expect, it } from 'vitest'
import {
  MAX_LUMINANCE,
  MIN_LUMINANCE,
  contrastRatio,
  customAvatarStyle,
  legible,
  legibleHex,
  luminance,
  parseHex,
  toHex
} from '../customTone'

/** The two surfaces an avatar is ever drawn on. */
const DARK_SURFACE = parseHex('#111111')!
const LIGHT_SURFACE = parseHex('#f9f8f5')!

/**
 * WCAG 1.4.11 non-text contrast. The monogram is `aria-hidden` decoration
 * beside the sender's name in real text, so it is a graphical object rather
 * than something anyone has to read — 3:1 is the standard that applies, and
 * the band in `customTone.ts` is solved from it against these two surfaces.
 */
const FLOOR = 3

describe('parseHex', () => {
  it('reads both lengths, with or without the hash', () => {
    expect(parseHex('#ff8800')).toEqual({ r: 255, g: 136, b: 0 })
    expect(parseHex('ff8800')).toEqual({ r: 255, g: 136, b: 0 })
    expect(parseHex('#f80')).toEqual({ r: 255, g: 136, b: 0 })
  })

  it('rejects anything that is not a colour', () => {
    for (const value of ['', '#', 'red', '#12345', '#gggggg', 'rgb(1,2,3)']) {
      expect(parseHex(value), value).toBeNull()
    }
  })

  it('round-trips through toHex', () => {
    expect(toHex(parseHex('#4f8cff')!)).toBe('#4f8cff')
  })
})

describe('legible', () => {
  const SAMPLES = [
    '#000000',
    '#ffffff',
    '#ff0000',
    '#00ff00',
    '#0000ff',
    '#ffff00',
    '#00ffff',
    '#ff00ff',
    '#808080',
    '#1a1a2e',
    '#fdfd96',
    '#4f8cff'
  ]

  it('lands every colour inside the readable band', () => {
    for (const sample of SAMPLES) {
      const result = luminance(legible(parseHex(sample)!))
      expect(result, sample).toBeGreaterThanOrEqual(MIN_LUMINANCE - 0.001)
      expect(result, sample).toBeLessThanOrEqual(MAX_LUMINANCE + 0.001)
    }
  })

  it('clears 3:1 on both surfaces, whichever theme the reader is in', () => {
    for (const sample of SAMPLES) {
      const safe = legible(parseHex(sample)!)
      expect(contrastRatio(safe, DARK_SURFACE), `${sample} on dark`).toBeGreaterThanOrEqual(FLOOR)
      expect(contrastRatio(safe, LIGHT_SURFACE), `${sample} on light`).toBeGreaterThanOrEqual(FLOOR)
    }
  })

  it('rescues the two colours that break a naive lightness clamp', () => {
    // Pure yellow sits at 50% HSL lightness and is still invisible on an
    // off-white page; pure black has no lightness to clamp at all.
    expect(contrastRatio(legible(parseHex('#ffff00')!), LIGHT_SURFACE)).toBeGreaterThanOrEqual(
      FLOOR
    )
    expect(contrastRatio(legible(parseHex('#000000')!), DARK_SURFACE)).toBeGreaterThanOrEqual(FLOOR)
  })

  it('is idempotent — a corrected colour needs no further correction', () => {
    for (const sample of SAMPLES) {
      const once = legible(parseHex(sample)!)
      expect(toHex(legible(once)), sample).toBe(toHex(once))
    }
  })

  it('derives its band from the surfaces rather than hard-coding it', () => {
    // If a palette moves, this is the test that should fail first.
    const solveMin = (surface: typeof DARK_SURFACE): number =>
      FLOOR * (luminance(surface) + 0.05) - 0.05
    const solveMax = (surface: typeof LIGHT_SURFACE): number =>
      (luminance(surface) + 0.05) / FLOOR - 0.05
    expect(MIN_LUMINANCE).toBeGreaterThanOrEqual(solveMin(DARK_SURFACE))
    expect(MAX_LUMINANCE).toBeLessThanOrEqual(solveMax(LIGHT_SURFACE))
  })

  it('keeps the hue the reader picked', () => {
    // Scaling a too-bright colour down must not turn red into pink or grey:
    // the channel that dominated still dominates by the same margin.
    const safe = legible(parseHex('#ff0000')!)
    expect(safe.r).toBeGreaterThan(safe.g)
    expect(safe.r).toBeGreaterThan(safe.b)
    expect(safe.g).toBeCloseTo(safe.b, 5)
  })

  it('darkens rather than brightens something too bright', () => {
    expect(luminance(legible(parseHex('#ffffff')!))).toBeLessThan(luminance(parseHex('#ffffff')!))
  })
})

describe('customAvatarStyle', () => {
  it('returns the two properties the avatar reads', () => {
    const style = customAvatarStyle('#ff0000') as Record<string, string>
    expect(style['--avatar-fg']).toMatch(/^#[0-9a-f]{6}$/)
    expect(style['--avatar-bg']).toMatch(/^rgba\(\d+, \d+, \d+, 0\.16\)$/)
  })

  it('gives nothing back for a value that is not a colour', () => {
    expect(customAvatarStyle('not a colour')).toBeUndefined()
  })
})

describe('legibleHex', () => {
  it('normalizes a picked colour into the readable luminance band', () => {
    const safe = legibleHex('#ffffff')
    expect(safe).toMatch(/^#[0-9a-f]{6}$/)
    expect(luminance(parseHex(safe!)!)).toBeLessThanOrEqual(MAX_LUMINANCE + 0.001)
  })

  it('rejects a value that is not a colour', () => {
    expect(legibleHex('blue')).toBeNull()
  })
})
