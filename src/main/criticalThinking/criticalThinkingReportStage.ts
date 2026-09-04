import type { CriticalThinkingSynthesisStage } from '@shared/criticalThinking.types'

/**
 * Whether the stage that produced the shipped report should stop the run
 * calling itself complete.
 *
 * This used to name three stages and treat them alike, which put the
 * small-context strategy in the same bucket as giving up. Run 56 (2026-09-04,
 * 8K context) is the case that shows the difference: all six sections were
 * written by the model and repaired to valid, the assembled report came back
 * `valid`, `usable`, `safe`, 31 cited blocks and no issues -- and the run was
 * reported `partial` anyway, on the sole ground that hierarchical recovery
 * produced it. A report that passes every validity, usability and safety check
 * is not a partial result; how it was produced is a fact about the run, not a
 * defect in the artifact.
 *
 * The two fallbacks are different in kind. Both replace the model's prose with
 * text Anodex assembled from raw excerpts, so a report resting on them really
 * is short of what was asked for.
 *
 * That leaves the case worth being careful about: `assembleHierarchicalReport`
 * takes whatever sections it has, and a section that failed every attempt is
 * replaced by the same deterministic excerpt builder. So a hierarchical report
 * is only the model's own work when none of its shipped sections came from
 * that builder -- which is what `usedDeterministicSections` reports.
 */
export function isRecoveredStage(
  stage: CriticalThinkingSynthesisStage,
  usedDeterministicSections: boolean
): boolean {
  if (stage === 'deterministic-fallback' || stage === 'section-fallback') return true
  if (stage === 'hierarchical-report') return usedDeterministicSections
  return false
}
