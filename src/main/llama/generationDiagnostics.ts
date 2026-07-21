/**
 * Bounded, non-sensitive counters explaining where one local generation's
 * output budget went — see `docs/CONTEXT_ADAPTIVE_RUNTIME_RECOVERY_HANDOFF.md`,
 * P0-C. A live 8K project-chat turn hit the safe token ceiling with only 135
 * visible characters and 304 thought characters produced against 2,815
 * consumed tokens; without a separate function-parameter counter that gap is
 * invisible; with one, an unfinished/oversized tool call is distinguishable
 * from excessive thought or a genuinely too-small budget.
 *
 * Never carries hidden chain-of-thought text or raw function arguments —
 * only token/character counts and a bounded in-flight function name.
 */
export interface LocalGenerationDiagnostics {
  visibleTokens: number
  thoughtTokens: number
  functionParameterTokens: number
  unfinishedFunctionName?: string
  unfinishedFunctionParameterChars?: number
  completedToolCalls: number
  contextShifts: number
}

/**
 * Tracks one generation turn's counters as it streams. `maxParallelFunctionCalls: 1`
 * (set on every tool-enabled `promptWithMeta` call — see `LlamaService.generate`)
 * guarantees native function calls execute strictly in `callIndex` order, one at
 * a time, so whichever call's params most recently streamed and hasn't yet
 * settled (a terminal `onActivity` status) is the one in flight when generation
 * stops.
 */
export class GenerationDiagnosticsTracker {
  private visibleTokens = 0
  private thoughtTokens = 0
  private functionParameterTokens = 0
  private completedToolCalls = 0
  private contextShifts = 0
  private currentCall: { callIndex: number; name: string; chars: number } | undefined

  recordVisibleTokens(count: number): void {
    this.visibleTokens += Math.max(0, count)
  }

  recordThoughtTokens(count: number): void {
    this.thoughtTokens += Math.max(0, count)
  }

  /** `chars` is a length only — the actual argument text is never retained. */
  recordFunctionParameterChunk(
    callIndex: number,
    name: string,
    tokenCount: number,
    chars: number
  ): void {
    this.functionParameterTokens += Math.max(0, tokenCount)
    this.currentCall =
      this.currentCall?.callIndex === callIndex
        ? { callIndex, name, chars: this.currentCall.chars + chars }
        : { callIndex, name, chars }
  }

  /** Call once per terminal (`success`/`error`/`denied`) tool activity, never for `running`. */
  recordToolCallSettled(): void {
    this.completedToolCalls += 1
    this.currentCall = undefined
  }

  recordContextShift(): void {
    this.contextShifts += 1
  }

  snapshot(): LocalGenerationDiagnostics {
    return {
      visibleTokens: this.visibleTokens,
      thoughtTokens: this.thoughtTokens,
      functionParameterTokens: this.functionParameterTokens,
      completedToolCalls: this.completedToolCalls,
      contextShifts: this.contextShifts,
      unfinishedFunctionName: this.currentCall?.name,
      unfinishedFunctionParameterChars: this.currentCall?.chars
    }
  }
}
