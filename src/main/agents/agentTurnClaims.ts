import type { Plan } from '@shared/plan.types'
import { projectStore } from '../projects/ProjectStore'
import { findUnverifiedPathClaims, type PathClaimIssue } from '../tools/pathClaimVerification'
import {
  findUnverifiedMeasurements,
  type MeasurementClaim
} from '../tools/measurementClaimVerification'
import { existsSync } from 'node:fs'
import { resolveInWorkspace } from '../tools/workspace'
import type { TaskLedger } from '../tools/taskLedger'

/** What a turn's reply claimed, checked against what the turn actually did. */
export interface TurnClaimAssessment {
  /** Paths the reply named that this task neither touched nor found on disk. */
  unverifiedPaths: PathClaimIssue[]
  /** Figures the reply stated as measured that appear in no tool output. */
  unverifiedMeasurements: MeasurementClaim[]
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
  ledger: TaskLedger,
  toolOutput = ''
): Promise<TurnClaimAssessment> {
  const unverifiedPaths = await findUnverifiedPathClaims(content, workspaceRoot, ledger.reads)
  return {
    unverifiedPaths,
    // Only the path claims raise the fabrication flag, matching the bounded
    // path exactly. A stated figure that no tool printed is worth showing the
    // reader, but it is a weaker signal than a named file that was never
    // touched, and it is not the one the reliability score is built on.
    unverifiedMeasurements: findUnverifiedMeasurements(content, toolOutput),
    fabricationDetected: unverifiedPaths.length > 0
  }
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

/**
 * Consecutive do-nothing turns before a run is stopped.
 *
 * Above two on purpose. A turn that reasons and then acts on the next one is
 * ordinary, and a limit of one or two would end runs that were about to work.
 * Three in a row is a model that has stopped driving the loop.
 */
export const IDLE_TURN_LIMIT = 3

/**
 * Why a run is being stopped for doing nothing, or `null` to keep going.
 *
 * An agent turn can only deliver anything through a tool call - `finish_goal`
 * included - so a turn with no calls at all has produced prose nobody will
 * read. Nothing watched for a run of them, and runs sat spinning until their
 * turn cap.
 *
 * Measured twice, on models three sizes apart. A Qwen3-4B run spent turns 22
 * through 30 - nine consecutive turns - making no tool calls and then hit its
 * limit with an empty workspace and a plan at 0/4. DeepSeek-R1-Distill-32B did
 * the same for six turns, emitting byte-identical replies each time.
 *
 * Counted in tool calls rather than by comparing replies. Two models produced
 * this and only one of them repeated itself, so the repetition was incidental;
 * "did this turn do anything" is the question, and it needs no text comparison
 * and behaves the same in every language.
 *
 * The reason states what was observed and nothing more. Why a model stopped
 * calling tools is not knowable from here - a small context, an unparseable
 * reply and a model that has simply given up all look identical at this level -
 * and a run that guessed at the cause would be guessing in the user's name.
 */
export function idleRunReason(consecutiveIdleTurns: number): string | null {
  if (consecutiveIdleTurns < IDLE_TURN_LIMIT) return null
  return (
    `Stopped after ${consecutiveIdleTurns} turns in a row without making a single tool call. ` +
    'The model was still replying, but an agent run can only act - or finish - through a tool, ' +
    'so those turns changed nothing and the next ones were unlikely to. Nothing here says why it ' +
    'stopped calling tools; the transcript will show what it was saying instead.'
  )
}

/**
 * Which claimed paths are still unaccounted for once the run is over.
 *
 * A path claim is a run-level question, not a per-turn one. Assessed per turn
 * it produced a false accusation immediately: a correct Rust run was badged
 * "Possible fabrication" because its first turn wrote a plan saying it would
 * work in `src/lib.rs` - its only call that turn was `write_plan` - and nothing
 * had been read yet. Turn 2 read that file three times.
 *
 * An agent run's opening turn is normally exactly that: naming the files it is
 * about to open. Treating an intention as a claim about completed work is the
 * "cries wolf" failure this module's own comments warn about, and a false
 * accusation on a correct run is worse than no check at all.
 *
 * The check keeps its teeth. A file named and never opened all run is still
 * reported, which is the documented case - a synthesis turn inventing coverage
 * of files it never read.
 */
export function stillUnverified(
  claimed: PathClaimIssue[],
  workspaceRoot: string | null,
  ledger: TaskLedger
): PathClaimIssue[] {
  if (!workspaceRoot) return []
  const seen = new Set<string>()
  const remaining: PathClaimIssue[] = []
  for (const issue of claimed) {
    if (seen.has(issue.path)) continue
    seen.add(issue.path)
    let absolute: string
    try {
      absolute = resolveInWorkspace(workspaceRoot, issue.path)
    } catch {
      continue
    }
    // Read or written at any point in the run settles it.
    if (ledger.reads.hasInteracted(absolute)) continue
    // A path reported missing that now exists was created by the run itself.
    if (issue.reason === 'not-found' && existsSync(absolute)) continue
    remaining.push(issue)
  }
  return remaining
}
