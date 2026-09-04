import { describe, expect, it } from 'vitest'
import { isRecoveredStage } from '../criticalThinkingReportStage'

/**
 * Run 56 (2026-09-04, 8K context) produced a report that passed every check
 * the product applies -- `valid`, `usable`, `safe`, 31 cited substantive
 * blocks, zero issues, all six sections written by the model and repaired to
 * valid -- and was reported to the user as `partial`. The only blocker was
 * `recovered-stage`: hierarchical recovery had produced it.
 *
 * Hierarchical recovery is the designed answer to a small context, not a
 * degradation. Reporting its success as a partial failure tells a user on
 * modest hardware that the feature does not work for them, when it just did.
 */
describe('isRecoveredStage', () => {
  it('accepts a hierarchical report whose sections are all the model own work', () => {
    expect(isRecoveredStage('hierarchical-report', false)).toBe(false)
  })

  it('still rejects a hierarchical report propped up by an excerpt dump', () => {
    // `assembleHierarchicalReport` uses whatever sections it has, and a section
    // that failed every attempt is replaced by the deterministic excerpt
    // builder. Then the assembled report is standing on the same raw excerpts
    // the fallbacks below are rejected for.
    expect(isRecoveredStage('hierarchical-report', true)).toBe(true)
  })

  it('rejects the fallbacks whatever the sections did', () => {
    // Both replace the model's prose with text Anodex assembled from raw
    // excerpts, so a report resting on one is short of what was asked for.
    for (const used of [false, true]) {
      expect(isRecoveredStage('deterministic-fallback', used)).toBe(true)
      expect(isRecoveredStage('section-fallback', used)).toBe(true)
    }
  })

  it('accepts the model own one-shot report', () => {
    for (const used of [false, true]) {
      expect(isRecoveredStage('draft', used)).toBe(false)
      expect(isRecoveredStage('repair', used)).toBe(false)
    }
  })
})
