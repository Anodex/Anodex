import type { GenerationStats, GenerationStopReason } from '@shared/chat.types'
import type { RunGenerationResult } from '../chat/runGeneration'

/**
 * Result of one Critical Thinking structured phase (plan/query/assessment/
 * synthesis): a bounded, tool-free generation whose text is expected to parse
 * into a typed artifact. `value`/`valid` describe the artifact itself,
 * independent of how generation ended — a recoverable provider limit
 * (token/context-shift/round/time) that still produced valid output is not a
 * failure. Only `userStopped` means the artifact must not be used.
 */
export interface StructuredPhaseResult<T> {
  value: T | null
  valid: boolean
  /** Why parsing failed, when it did — fed into one bounded repair attempt. */
  issues: string[]
  /** Raw model text, retained for diagnostics even when parsing failed. */
  content: string
  stats: GenerationStats
  stopReason?: GenerationStopReason
  userStopped: boolean
}

export interface StructuredPhaseDeps<T> {
  /** Runs one isolated, tool-free generation for the given prompt. */
  generate: (prompt: string) => Promise<RunGenerationResult>
  /** Parses and validates raw model text into a typed artifact. */
  parse: (content: string) => { value: T | null; valid: boolean; issues?: string[] }
  /**
   * Builds a bounded repair prompt from the first attempt's raw content and
   * validation issues, run once when the first attempt produced no valid
   * artifact and the phase was not stopped by the user. Omit to disable
   * repair for phases where a second isolated call isn't worth the latency.
   */
  buildRepairPrompt?: (previousContent: string, issues: string[]) => string
}

/**
 * Runs a bounded, tool-free Critical Thinking phase and accepts a valid
 * artifact even after a recoverable provider stop (token/context limit) —
 * only a genuine user Stop, or an orchestration-level stop (time/tool/round
 * budget, loop guard, no progress), discards it without even trying to parse
 * the content. This is the shared fix for the bug where a valid
 * plan/query/assessment/report was thrown away because generation happened
 * to end on a recoverable output-size limit instead of a clean completion:
 * the artifact is validated first, and only then is the termination reason
 * consulted to decide how to report an incomplete result.
 */
export async function runStructuredPhase<T>(
  prompt: string,
  signal: AbortSignal,
  deps: StructuredPhaseDeps<T>
): Promise<StructuredPhaseResult<T>> {
  const first = await runOneAttempt(prompt, signal, deps)
  if (
    first.value !== null ||
    first.userStopped ||
    !isRecoverableContentStopReason(first.stopReason) ||
    !deps.buildRepairPrompt
  ) {
    return first
  }

  const repair = await runOneAttempt(
    deps.buildRepairPrompt(first.content, first.issues),
    signal,
    deps
  )
  return { ...repair, stats: addStats(first.stats, repair.stats) }
}

async function runOneAttempt<T>(
  prompt: string,
  signal: AbortSignal,
  deps: StructuredPhaseDeps<T>
): Promise<StructuredPhaseResult<T>> {
  const result = await deps.generate(prompt)
  const stopReason = signalStopReason(signal, result.stopReason)
  const userStopped = stopReason === 'user'
  // Only worth parsing when nothing stopped it, or when the stop was the
  // provider/wrapper cutting output off at a size ceiling — an
  // orchestration-level stop (including a real user Stop) means the
  // orchestrator itself decided this attempt must end now, so the partial
  // content is never attempted.
  const parsed = isRecoverableContentStopReason(stopReason)
    ? deps.parse(result.content)
    : { value: null, valid: false, issues: [] }
  return {
    value: parsed.value,
    valid: parsed.valid,
    issues: parsed.issues ?? [],
    content: result.content,
    stats: result.stats,
    stopReason,
    userStopped
  }
}

/**
 * Stop reasons that mean the provider or local wrapper cut generation off at
 * an output/context size ceiling — the text produced up to that point can
 * still be a complete, valid artifact, so it is worth parsing. Every other
 * non-clean stop (a time, tool, or round budget; the loop guard; no
 * progress; an unspecified yield; or a genuine user Stop) means the
 * orchestration itself decided this attempt must end now, and the partial
 * content is not attempted — matching the pre-existing, tested behavior for
 * those reasons.
 */
const RECOVERABLE_CONTENT_STOP_REASONS: ReadonlySet<GenerationStopReason> = new Set([
  'token-limit',
  'context-shift-limit',
  'context-limit',
  'fixed-context-limit'
])

export function isRecoverableContentStopReason(reason: GenerationStopReason | undefined): boolean {
  return !reason || RECOVERABLE_CONTENT_STOP_REASONS.has(reason)
}

/**
 * True user cancellation always wins over whatever the provider itself
 * reports for `stopReason` (e.g. a token limit that happened to fire in the
 * same moment as the abort).
 */
export function signalStopReason(
  signal: AbortSignal | undefined,
  fallback: GenerationStopReason | undefined
): GenerationStopReason | undefined {
  if (!signal?.aborted) return fallback
  return signal.reason === 'time-limit' ? 'time-limit' : (fallback ?? 'user')
}

export function addStats(current: GenerationStats | null, next: GenerationStats): GenerationStats {
  const tokens = (current?.tokens ?? 0) + next.tokens
  const durationMs = (current?.durationMs ?? 0) + next.durationMs
  return { tokens, durationMs, tokensPerSecond: durationMs > 0 ? tokens / (durationMs / 1000) : 0 }
}
