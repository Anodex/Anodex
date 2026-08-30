import type { Plan } from '@shared/plan.types'
import { projectStore } from '../projects/ProjectStore'
import { findUnverifiedPathClaims, type PathClaimIssue } from '../tools/pathClaimVerification'
import type { TaskLedger } from '../tools/taskLedger'

/** What a turn's reply claimed, checked against what the turn actually did. */
export interface TurnClaimAssessment {
  /** Paths the reply named that this task neither touched nor found on disk. */
  unverifiedPaths: PathClaimIssue[]
  /** See `AgentRun.flaggedTurns` — drives the "Possible fabrication" badge. */
  fabricationDetected: boolean
}

/**
 * Check an agent turn's reply against the workspace, the way a bounded reply is
 * already checked.
 *
 * `GenerateOutcome.fabricationDetected` says of itself that it is "set by
 * `runBoundedChatGeneration`, not by any transport", and that unattended
 * callers "surface this afterwards rather than silently reporting success".
 * Agent runs call `runGeneration` directly and never go through the bounded
 * runner, so nothing ever set it and the flag was structurally always false on
 * exactly the path where nobody is watching - the opposite of the intent
 * written beside it.
 *
 * Measured: a run finished `done` with `flaggedTurns: 0` and a summary saying a
 * function "has been successfully implemented and verified" and that the smoke
 * test "passed with exit code 0". The run had made no write, edit or patch call
 * at all. The turn account underneath said "Changed nothing", so the truth was
 * on the page - but the status and the badge both read as success.
 *
 * The same check as the bounded path, deliberately: a claim is doubted because
 * the workspace disagrees with it, never because of how the sentence was
 * phrased. Phrase detectors were tried here before and removed for deciding a
 * durable reliability penalty from a model's writing style.
 */
export async function assessTurnClaims(
  content: string,
  workspaceRoot: string | null,
  ledger: TaskLedger
): Promise<TurnClaimAssessment> {
  const unverifiedPaths = await findUnverifiedPathClaims(content, workspaceRoot, ledger.reads)
  return { unverifiedPaths, fabricationDetected: unverifiedPaths.length > 0 }
}

/** The folder a run's project points at, or null when it has no project. */
export function workspaceRootForProject(projectId: string | null | undefined): string | null {
  if (!projectId) return null
  return (
    projectStore.getState().projects.find((project) => project.id === projectId)?.folderPath ?? null
  )
}

/**
 * Whether a run that called `finish_goal` has anything to show for itself.
 *
 * `finish_goal` is deliberately hard to refuse. The guard tells a model about
 * its open plan steps once and then lets the call through, because refusing it
 * repeatedly is how runs used to burn their whole budget arguing with a gate.
 * That is the right trade - but it means a run can declare success having done
 * nothing, and be recorded as `done` like any other.
 *
 * Measured: a run finished with six plan steps open, zero write, edit or patch
 * calls in sixteen turns, and a summary stating the function "has been
 * successfully implemented and verified" and that the smoke test "passed with
 * exit code 0". None of it had happened. The turn account underneath said
 * "Changed nothing", so the disclosure worked; the status said `done`.
 *
 * This changes nothing about whether the run may finish. It only decides
 * whether the result is presented as unqualified success, which is a claim
 * Anodex is making, not the model.
 *
 * Both conditions are needed. A run with no plan, or one whose every step is
 * complete, may legitimately have written nothing - "explain this module",
 * "is this safe to delete" - and flagging those would put a warning on exactly
 * the runs that behaved correctly.
 */
export function finishedWithNothingToShow(input: {
  durableChanges: number
  plan: Plan | null
}): boolean {
  if (input.durableChanges > 0) return false
  const steps = input.plan?.steps ?? []
  return steps.some((step) => step.status !== 'completed')
}
