import { describe, expect, it } from 'vitest'
import {
  describeUnverifiedMeasurements,
  findUnverifiedMeasurements
} from '../measurementClaimVerification'

/**
 * The driving incident: a run reported the corona "verified" with a radial
 * profile it had never measured. A pixel probe of the image it had just
 * rendered showed a flat disc. Every existing guard passed it, because they all
 * ask whether verification happened, not whether it found what was claimed.
 */
describe('findUnverifiedMeasurements', () => {
  it('flags a measurement that appears in no tool output', () => {
    const reply =
      'Verified: bright core ~157 → 23.6 at r=14 → background 8.5 by r=34, no hard edge.'
    const output = 'wrote preview.png (1280x800)\nbodies: 9, steps: 300'

    const issues = findUnverifiedMeasurements(reply, output)

    expect(issues.map((i) => i.text)).toContain('23.6')
    expect(issues.map((i) => i.text)).toContain('8.5')
  })

  it('says nothing when the figure really is in the output', () => {
    const reply = 'Momentum check passed with rel.err 1.456e-16 across 153 bodies.'
    const output = 'momentum check: |P0|=1561.68 |P500|=1561.68 rel.err=1.456e-16 bodies=153'

    expect(findUnverifiedMeasurements(reply, output)).toEqual([])
  })

  /** Rounding a real measurement is careful reporting, not invention. */
  it('accepts a rounded quotation of something measured', () => {
    const reply = 'Momentum conserved to 1.6e-15.'
    const output = 'momentum check: rel.err=1.600e-15'

    expect(findUnverifiedMeasurements(reply, output)).toEqual([])
  })

  it('matches a figure written with thousands separators', () => {
    const reply = 'It drew 958,464 triangles.'
    const output = 'triangles: 958464 total (6144 per body)'

    expect(findUnverifiedMeasurements(reply, output)).toEqual([])
  })

  /**
   * A check that cries wolf gets ignored, so ordinary counts and round figures
   * are deliberately out of scope.
   */
  it('ignores counts, small integers and round figures a model reasons to', () => {
    const reply = 'Edited 3 files, ran 2 commands, added about 140 asteroids and 9 moons.'

    expect(findUnverifiedMeasurements(reply, '')).toEqual([])
  })

  it('reports each distinct figure once', () => {
    const reply = 'Saw 23.6 then 23.6 again, and also 41.75.'

    expect(findUnverifiedMeasurements(reply, '')).toHaveLength(2)
  })
})

describe('describeUnverifiedMeasurements', () => {
  it('says nothing when there is nothing to flag', () => {
    expect(describeUnverifiedMeasurements([])).toBeNull()
  })

  it('names the figures and calls them unverified rather than false', () => {
    const note = describeUnverifiedMeasurements([{ text: '23.6' }, { text: '8.5' }])

    expect(note).toContain('23.6')
    expect(note).toContain('unverified')
  })

  it('summarises rather than listing a long tail', () => {
    const many = ['1.1', '2.2', '3.3', '4.4', '5.5', '6.6'].map((text) => ({ text }))

    expect(describeUnverifiedMeasurements(many)).toContain('and 2 more')
  })
})
