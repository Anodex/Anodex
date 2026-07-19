import type { GenerationStopReason } from '@shared/chat.types'

export interface GenerationBudgetPolicy {
  maxDurationMs: number
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

export function interactiveBudgetForContext(
  contextSize: number | undefined
): GenerationBudgetPolicy {
  if (!contextSize) return DEFAULT_INTERACTIVE_BUDGET
  return {
    ...DEFAULT_INTERACTIVE_BUDGET,
    maxContextShifts: Math.max(2, Math.min(12, Math.ceil(contextSize / 4_096) * 2))
  }
}

/** One-turn wall-clock/tool budget shared by every model provider. */
export class GenerationBudget {
  private readonly controller = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>
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
    this.timer = setTimeout(() => this.stop('time-limit'), policy.maxDurationMs)
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
      this.stop('tool-limit')
      return limitMessage('tool-limit')
    }
    return null
  }

  recordContextShift(): void {
    this.contextShifts++
    if (this.contextShifts > this.policy.maxContextShifts) this.stop('context-limit')
  }

  stop(reason: GenerationStopReason): void {
    if (this.reason) return
    this.reason = reason
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
  return 'This turn has been stopped. Do not start another tool call.'
}
