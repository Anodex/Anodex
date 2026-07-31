import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RAIL_WIDTH,
  MIN_RAIL_WIDTH,
  MIN_READER_WIDTH,
  clampRailWidth,
  maxRailWidth
} from '../railWidth'

describe('clampRailWidth', () => {
  it('leaves a width the panel can afford alone', () => {
    expect(clampRailWidth(520, 1600)).toBe(520)
  })

  it('never lets the rail crush the mail it is discussing', () => {
    // The whole point of the bounds: dragging the rail across the pane would
    // turn it back into the Chat page with an email behind it.
    const width = clampRailWidth(1500, 1600)

    expect(width).toBeLessThanOrEqual(1600 - MIN_READER_WIDTH)
    expect(1600 - width).toBeGreaterThanOrEqual(MIN_READER_WIDTH)
  })

  it('caps the rail by share on a wide display, before the reader floor bites', () => {
    // On a 2400px panel the reader floor would still allow a 1940px rail —
    // absurd. The share is what stops it.
    expect(clampRailWidth(2000, 2400)).toBeLessThan(2400 - MIN_READER_WIDTH)
    expect(clampRailWidth(2000, 2400)).toBeCloseTo(2400 * 0.55, 0)
  })

  it('holds the rail at its floor rather than shrinking it away', () => {
    expect(clampRailWidth(80, 1600)).toBe(MIN_RAIL_WIDTH)
  })

  it('keeps the floor on a panel too narrow for both minimums', () => {
    // 700px cannot give the rail 300 and the reader 460. The bounds must not
    // invert and snap the rail shut — it keeps its floor and the mail scrolls.
    expect(clampRailWidth(400, 700)).toBe(MIN_RAIL_WIDTH)
    expect(maxRailWidth(700)).toBe(MIN_RAIL_WIDTH)
  })

  it('leaves the stored width intact before the panel has been measured', () => {
    // First paint reports a width of 0. Clamping against that would rewrite a
    // remembered 520px rail down to the floor on every app start.
    expect(clampRailWidth(520, 0)).toBe(520)
  })

  it('falls back to the default rather than propagating a broken number', () => {
    expect(clampRailWidth(Number.NaN, 1600)).toBe(DEFAULT_RAIL_WIDTH)
  })

  it('rounds to whole pixels', () => {
    expect(clampRailWidth(420.6, 1600)).toBe(421)
  })
})
