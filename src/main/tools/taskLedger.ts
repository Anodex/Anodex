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
  /** Full tool results, outside the context window — see `TurnEvidenceStore`. */
  readonly evidence: TurnEvidenceStore = createTurnEvidenceStore()
  private readonly loopGuard: LoopGuardState = createLoopGuardState()
  /** Settled gathering calls since the last durable change — see `GATHERING_*`. */
  private gatheringStreak = 0

  /**
   * Decide what to do with a call that is about to run.
   *
   * `run` is the overwhelmingly common answer. The other two exist because
   * repetition has two very different causes, and treating them alike is what
   * deadlocked long tasks:
   *
   * - **redirect** — the call repeats work whose result this task still holds.
   *   The model is not being stubborn; it is asking again because the result was
   *   evicted from its context to make room. Point it at the stored copy.
   * - **block** — the call repeats work with nothing to show for it and nothing
   *   to recall. This is the real loop the guard was built for.
   *
   * Note that only a *stable read* can be redirected. A `run_command` or an
   * edit repeated with identical arguments is not asking for information it
   * already has; re-running it may be the whole point, or may be a loop, but it
   * is never answered by handing back an old result.
   */
  reviewCall(spec: {
    name: string
    kind: ToolKind
    key: string
    args?: unknown
    /** Path or identifier whose stored evidence could answer a repeat, if any. */
    evidenceHint?: string
    /** Whether a repeat of this call could be satisfied from a stored result. */
    recallable?: boolean
  }): LedgerVerdict {
    const gathering = this.reviewGathering(spec.kind)
    if (gathering) return gathering

    const guard = checkLoopGuard(this.loopGuard, spec.name, spec.key, spec.args)
    if (!guard.blocked) return { action: 'run' }

    if (spec.recallable && spec.evidenceHint) {
      const stored = this.evidence.idsMentioning(spec.evidenceHint)
      if (stored.length > 0) {
        return {
          action: 'redirect',
          detail: 'Redirected to stored evidence',
          message:
            `You have already called ${spec.name} this way ${guard.count} times this turn. ` +
            `That result is still stored — call recall_evidence("${stored[0]}") to read it back ` +
            '(add a match argument to jump straight to what you need) rather than running the ' +
            'tool again.'
        }
      }
    }

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
      return { action: 'block', detail: 'Blocked: gathering without progress', message }
    }
    return { action: 'advise', message }
  }

  /**
   * Record how a call settled. Called once per settled call from the tool
   * runners, so the gathering streak measures work that actually happened
   * rather than work that was attempted.
   */
  recordOutcome(spec: { kind: ToolKind; madeProgress: boolean }): void {
    if (!spec.madeProgress) {
      // A refusal, a redirect, or a recall. It consumed a round trip and
      // produced nothing durable, so it counts toward the streak whatever its
      // kind — this is exactly the shape of the run that spent fifty calls
      // recalling.
      this.gatheringStreak++
      return
    }
    if (GATHERING_KINDS.has(spec.kind)) this.gatheringStreak++
    else this.gatheringStreak = 0
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
  /** Repeated work this task can serve from storage — answer, don't refuse. */
  | { action: 'redirect'; message: string; detail: string }
  /** Refuse this call but let the turn continue. */
  | { action: 'block'; message: string; detail: string }
  /** A loop that survived being refused: end the generation. */
  | { action: 'abort'; message: string; detail: string }

export function createTaskLedger(): TaskLedger {
  return new TaskLedger()
}
