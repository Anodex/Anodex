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
