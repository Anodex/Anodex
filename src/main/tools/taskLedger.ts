import {
  checkLoopGuard,
  createLoopGuardState,
  loopGuardMessage,
  type LoopGuardState
} from './loopGuard'
import type { ToolKind } from '@shared/tools.types'
import { createReadCoverageTracker, type ReadCoverageTracker } from './readCoverage'
import { createTurnEvidenceStore, type TurnEvidenceStore } from './evidenceStore'

/**
 * Everything one bounded task knows about what it has already done.
 *
 * ## Why these three are one object
 *
 * Line coverage, the loop guard, and the evidence store used to be threaded
 * separately through every transport, and each answered the same question —
 * *will this call produce anything new?* — from a different sliver of the
 * facts. They disagreed, and the disagreement was not academic: coverage said
 * "you already read that", the transport had just deleted the result and told
 * the model to read it again, and the loop guard blocked the retries in
 * between. One assistant message spent 157 tool calls inside that triangle and
 * completed zero writes (`docs/CONTEXT_SYSTEM_ROOT_CAUSE.md` §1).
 *
 * They are kept as distinct members rather than dissolved into one bag because
 * they genuinely do different jobs — which *lines* were served, which *calls*
 * repeated, which *bytes* are still recoverable. What they must not do is
 * answer the shared question independently, so that answer lives here, in
 * {@link TaskLedger.reviewCall}, with all three in view.
 *
 * ## Lifetime
 *
 * One bounded reply (`runBoundedChatGeneration`) or one agent run — deliberately
 * longer than a single provider call, because a context epoch resets the
 * model's history and must not reset what the *task* has established.
 */
export class TaskLedger {
  /** Which line ranges of which files have been served this task. */
  readonly reads: ReadCoverageTracker = createReadCoverageTracker()
  /** What this task has already gathered — see `TurnEvidenceStore`. */
  readonly evidence: TurnEvidenceStore = createTurnEvidenceStore()
  private readonly loopGuard: LoopGuardState = createLoopGuardState()
  /** Settled gathering calls since the last durable change — see `GATHERING_*`. */
  private gatheringStreak = 0
  /** Gathering calls this task refused outright. Reported, never acted on. */
  private blockedGatheringCalls = 0

  /**
   * Decide what to do with a call that is about to run.
   *
   * `run` is the overwhelmingly common answer. Repetition has two very
   * different causes, and treating them alike is what deadlocked long tasks:
   *
   * - a repeated **stable read** is usually not stubbornness — the result was
   *   trimmed out of the model's context to make room, so from where it sits
   *   the work genuinely has not been done. Let it run again.
   * - a repeated call that changes nothing and produces nothing is the real
   *   loop the guard was built for. **block** it.
   *
   * Note that only a *stable read* gets that latitude. A `run_command` or an
   * edit repeated with identical arguments is not re-acquiring information it
   * has lost sight of; re-running it may be the whole point, or may be a loop,
   * but it is not the eviction-driven repeat this allows for.
   */
  reviewCall(spec: {
    name: string
    kind: ToolKind
    key: string
    args?: unknown
    /** Whether repeating this call is a stable read that may simply run again. */
    rereadable?: boolean
  }): LedgerVerdict {
    const gathering = this.reviewGathering(spec.kind)
    if (gathering) return gathering

    const guard = checkLoopGuard(this.loopGuard, spec.name, spec.key, spec.args)
    if (!guard.blocked) return { action: 'run' }

    // A repeated *stable read* is allowed to run again, right up to the abort
    // backstop. This reverses the redirect that used to send it to a stored
    // copy, and it is the correction the live runs argued for.
    //
    // Forbidding the re-read is what made the retired `recall_evidence` tool
    // necessary at all, and recall was strictly worse than the thing it
    // replaced: a re-read costs one bounded call and returns what is on disk
    // *now*, while a recall cost a call and permanently enlarged replayed
    // history with a copy that was already stale. One measured run spent 39%
    // of 156 calls on recalls and still had four edits rejected for stale line
    // numbers — the model was being handed back the very copy that was out of
    // date.
    //
    // Re-reading is safe to allow because it is bounded elsewhere and by
    // construction: identical reads are collapsed to the newest in
    // `projectHistoryForModel`, so repeating one cannot compound context; the
    // gathering ladder still stops a turn that only looks; and `shouldAbort`
    // below remains the backstop against a model that has genuinely stuck.
    if (spec.rereadable && !guard.shouldAbort) return { action: 'run' }

    return {
      action: guard.shouldAbort ? 'abort' : 'block',
      detail: 'Blocked: repeated identical call',
      message: loopGuardMessage(spec.name, guard.count, guard.shouldAbort)
    }
  }

  /**
   * Stop a task that has become all input and no output.
   *
   * This is the guard the whole system was missing. The loop guard catches an
   * identical call; read coverage catches an identical range; nothing noticed a
   * turn that gathered *forty different things* and produced nothing. Two live
   * runs on the same request ended 157 calls / 0 writes and 103 calls / 0
   * writes, every individual call legitimately distinct.
   *
   * Counted in settled calls, never in prose, and reset by any durable change —
   * so a task that reads a lot and then edits gets a fresh allowance for the
   * next stretch of investigation. A genuinely read-only request (a diagnosis, a
   * question about the code) reaches the soft rung and is told to answer with
   * what it has, which is the right instruction there too.
   */
  private reviewGathering(kind: ToolKind): LedgerVerdict | null {
    if (!GATHERING_KINDS.has(kind)) return null
    if (this.gatheringStreak < GATHERING_SOFT_LIMIT) return null

    const message =
      `You have made ${this.gatheringStreak} information-gathering calls without changing ` +
      'anything. More looking is not moving this forward. Take the next concrete action with ' +
      'what you already have — make the edit, run the command, or give the user your answer — ' +
      'and say plainly what is blocking you if you cannot.'

    if (this.gatheringStreak >= GATHERING_HARD_LIMIT) {
      this.blockedGatheringCalls++
      return { action: 'block', detail: 'Blocked: gathering without progress', message }
    }
    return { action: 'advise', message }
  }

  /**
   * How many gathering calls this task refused outright.
   *
   * Exposed so the finished reply can *say* the run was cut short. A live turn
   * made 162 calls and six real edits, then had its last two calls blocked here
   * and simply ended — no stop reason, no error, no summary. The guard behaved
   * exactly as intended and the user saw a reply that stopped for no stated
   * reason, which is its own kind of failure.
   */
  get blockedGathering(): number {
    return this.blockedGatheringCalls
  }

  /**
   * Record how a call settled. Called once per settled call from the tool
   * runners, so the gathering streak measures work that actually happened
   * rather than work that was attempted.
   */
  recordOutcome(spec: {
    kind: ToolKind
    madeProgress: boolean
    /**
     * True when *this ledger* refused the call, rather than the call running
     * and achieving nothing. See below for why the difference matters.
     */
    refusedByLedger?: boolean
    /**
     * Whether this call is positive evidence that something changed.
     *
     * Only the gathering streak reads this. `madeProgress` is load-bearing for
     * the `finish_goal` evidence gate, durable-change reporting and the
     * runner's own progress checks, so it must keep meaning "this call did
     * something" — a command that changed the workspace has to stay progress
     * even when Anodex cannot tell that it did.
     *
     * Defaults to `madeProgress`, so every existing caller is unaffected.
     */
    provesChange?: boolean
  }): void {
    // A call this ledger refused is not evidence about the model; it is
    // evidence about the guard. Counting it made the streak self-feeding: past
    // the hard limit every refusal pushed the count higher, so blocking could
    // never stop, and the "N calls refused" figure reported to the user grew
    // from the guard's own output. Measured live at 22 refusals and at 10, on
    // runs that then spent half their turns making calls that could not run.
    //
    // The guard is not loosened by this. The streak still stands wherever the
    // model's own behaviour put it, still blocks there, and still resets only
    // on a durable change.
    if (spec.refusedByLedger) return
    if (!spec.madeProgress) {
      // A refusal or a no-op. It consumed a round trip and produced nothing
      // durable, so it counts toward the streak whatever its kind — this is
      // exactly the shape of the run that spent fifty calls re-acquiring what
      // it already had.
      this.gatheringStreak++
      return
    }
    if (GATHERING_KINDS.has(spec.kind)) {
      this.gatheringStreak++
      return
    }
    // Absence of evidence is not evidence of progress. A command Anodex cannot
    // classify used to reset the streak outright, which is how one run spent
    // about 170 of 208 calls gathering - 82 of them shell scripts of the shape
    // `python -c "open('ui.py').read()"` - while the guard built for exactly
    // that never fired: each unrecognised script bought a free reset.
    //
    // Unknown is deliberately *neutral* rather than counted as gathering. This
    // is what made the bug unfixable before: any rule that treated an unknown
    // command as gathering would have made running the test suite or a build
    // push a run toward being blocked, which is a worse failure than the one it
    // fixes. Neutral cannot do that - it can only stop a free reset.
    if (spec.provesChange ?? spec.madeProgress) this.gatheringStreak = 0
  }
}

/** Kinds that gather information rather than change anything. */
const GATHERING_KINDS = new Set<ToolKind>(['read', 'web', 'plan'])

/**
 * Gathering calls since the last durable change after which the model is told
 * to act. Generous: a real multi-file investigation legitimately reads this
 * much before it knows what to change.
 */
const GATHERING_SOFT_LIMIT = 22

/** …and after which further gathering is refused outright rather than served. */
const GATHERING_HARD_LIMIT = 34

/** What {@link TaskLedger.reviewCall} decided, and what to tell the model. */
export type LedgerVerdict =
  | { action: 'run'; message?: undefined; detail?: undefined }
  /** Run, but append a correction: the task is gathering without producing. */
  | { action: 'advise'; message: string; detail?: undefined }
  /** Refuse this call but let the turn continue. */
  | { action: 'block'; message: string; detail: string }
  /** A loop that survived being refused: end the generation. */
  | { action: 'abort'; message: string; detail: string }

export function createTaskLedger(): TaskLedger {
  return new TaskLedger()
}
