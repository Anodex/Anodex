import type { GenerationStopReason } from '@shared/chat.types'

export interface GenerationBudgetPolicy {
  /** `null` means no wall-clock cap — the turn runs until it finishes itself or hits another limit. */
  maxDurationMs: number | null
  maxTools: number
  maxProviderRounds: number
  maxContextShifts: number
}

export const DEFAULT_INTERACTIVE_BUDGET: GenerationBudgetPolicy = {
  maxDurationMs: 15 * 60_000,
  maxTools: 32,
  maxProviderRounds: 12,
  maxContextShifts: 6
}

export const CRITICAL_THINKING_STEP_BUDGET: GenerationBudgetPolicy = {
  maxDurationMs: 10 * 60_000,
  maxTools: 6,
  maxProviderRounds: 8,
  maxContextShifts: 2
}

export const AGENT_TURN_BUDGET: GenerationBudgetPolicy = {
  maxDurationMs: 15 * 60_000,
  maxTools: 32,
  maxProviderRounds: 12,
  maxContextShifts: 6
}

export const SCHEDULED_TASK_BUDGET: GenerationBudgetPolicy = {
  maxDurationMs: 10 * 60_000,
  maxTools: 20,
  maxProviderRounds: 8,
  maxContextShifts: 4
}

/**
 * Turns the user's `generation.turnTimeLimitMinutes` setting (`null` =
 * unlimited) into a policy override for the per-turn wall-clock cap.
 */
export function turnTimeLimitOverride(
  turnTimeLimitMinutes: number | null
): Pick<GenerationBudgetPolicy, 'maxDurationMs'> {
  return { maxDurationMs: turnTimeLimitMinutes === null ? null : turnTimeLimitMinutes * 60_000 }
}

/**
 * Rounds and tool calls a single `runGeneration` cycle may spend, scaled to the
 * window it has to spend them in.
 *
 * `maxProviderRounds` is a failsafe against a pathological loop, not a work
 * limit — the context wall and the cross-cycle no-progress guard are the real
 * stops. Left flat it stops being a failsafe and becomes the binding
 * constraint: a measured 16k run ended two cycles at exactly round 11, the
 * first of them with a third of its window still unused, and each restart then
 * paid the fixed-token re-entry cost again. Flat 12 happens to be well tuned
 * *for 16k* — there the cap and the context wall land within a round of each
 * other — so the calibration below reproduces it exactly at that size and only
 * changes behaviour for windows the constant was never chosen for. At 128k the
 * wall is a couple of hundred rounds away while a flat cap still fires at 12.
 *
 * `maxTools` moves with it at the same 8:3 ratio the flat pair already had.
 * Raising rounds alone would just hand the binding role to the tool ceiling,
 * since a round almost always carries one call.
 */
function cycleLimitsForContext(
  contextSize: number
): Pick<GenerationBudgetPolicy, 'maxProviderRounds' | 'maxTools'> {
  const maxProviderRounds = Math.max(6, Math.min(64, Math.ceil(contextSize / 4_096) * 3))
  return { maxProviderRounds, maxTools: Math.round((maxProviderRounds * 8) / 3) }
}

export function interactiveBudgetForContext(
  contextSize: number | undefined,
  turnTimeLimitMinutes: number | null = 15
): GenerationBudgetPolicy {
  const base = !contextSize
    ? DEFAULT_INTERACTIVE_BUDGET
    : {
        ...DEFAULT_INTERACTIVE_BUDGET,
        ...cycleLimitsForContext(contextSize),
        maxContextShifts: Math.max(4, Math.min(12, Math.ceil(contextSize / 4_096) * 4))
      }
  return { ...base, ...turnTimeLimitOverride(turnTimeLimitMinutes) }
}

/** One-turn wall-clock/tool budget shared by every model provider. */
export class GenerationBudget {
  private readonly controller = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout> | undefined
  private readonly onOuterAbort: () => void
  private toolAttempts = 0
  private contextShifts = 0
  private reason: GenerationStopReason | undefined

  constructor(
    readonly policy: GenerationBudgetPolicy,
    outerSignal?: AbortSignal
  ) {
    this.onOuterAbort = () => this.stop('user')
    if (outerSignal?.aborted) this.stop('user')
    else outerSignal?.addEventListener('abort', this.onOuterAbort, { once: true })
    this.timer =
      policy.maxDurationMs === null
        ? undefined
        : setTimeout(() => this.stop('time-limit'), policy.maxDurationMs)
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get stopReason(): GenerationStopReason | undefined {
    return this.reason
  }

  beforeTool(): string | null {
    if (this.reason) return limitMessage(this.reason)
    this.toolAttempts++
    if (this.toolAttempts > this.policy.maxTools) {
      // Soft-gate further tools so the model can consume this result and
      // return useful partial work. A later user/time/context abort still wins.
      this.reason = 'tool-limit'
      return limitMessage('tool-limit')
    }
    return null
  }

  recordContextShift(): void {
    this.contextShifts++
    if (this.contextShifts > this.policy.maxContextShifts) this.stop('context-shift-limit')
  }

  stop(reason: GenerationStopReason): void {
    if (this.controller.signal.aborted) return
    if (!this.reason || this.reason === 'tool-limit' || reason === 'user') this.reason = reason
    this.controller.abort()
  }

  dispose(outerSignal?: AbortSignal): void {
    clearTimeout(this.timer)
    outerSignal?.removeEventListener('abort', this.onOuterAbort)
  }
}

function limitMessage(reason: GenerationStopReason): string {
  if (reason === 'tool-limit') {
    return 'This turn reached its tool-call budget. Stop calling tools and return the useful partial result.'
  }
  if (reason === 'time-limit') {
    return 'This turn reached its time budget. Stop and return the useful partial result.'
  }
  if (reason === 'context-shift-limit') {
    return 'This turn reached its context-compaction budget. Stop and return the useful partial result.'
  }
  return 'This turn has been stopped. Do not start another tool call.'
}
