import type { GenerationStopReason } from '@shared/chat.types'

/**
 * Stop reasons that only end the *turn* that hit them, not a whole multi-turn
 * run — the caller can fall through to its own retry/continue logic instead
 * of treating the stop as final. Originally `AgentRunService`'s private
 * `isRecoverableTurnStop` (see `docs/CONTEXT_ADAPTIVE_RUNTIME_RECOVERY_HANDOFF.md`,
 * Phase 5) — extracted so `BoundedChatRunner` can reuse the exact same
 * classification instead of cloning it, per that handoff's explicit
 * instruction not to build a second, subtly different notion of "recoverable"
 * for chat.
 *
 * `'loop-guard'`: the guard's state is per-generation, so a fresh cycle starts
 * clean. `'no-progress'`, `'context-limit'`, `'context-shift-limit'`,
 * `'rounds-exhausted'`, `'tool-limit'`, `'token-limit'`, `'time-limit'`,
 * `'yielded'`: every one of these is a soft, bounded ceiling — the next cycle
 * can rebuild from compacted, persisted history and keep going. Every other
 * reason (a real user Stop, `'fixed-context-limit'`, or undefined/unknown)
 * ends the whole multi-cycle run, not just this turn.
 */
export function isRecoverableGenerationStop(stopReason: GenerationStopReason | undefined): boolean {
  return (
    stopReason === 'loop-guard' ||
    stopReason === 'no-progress' ||
    stopReason === 'context-limit' ||
    stopReason === 'context-shift-limit' ||
    stopReason === 'rounds-exhausted' ||
    stopReason === 'tool-limit' ||
    stopReason === 'token-limit' ||
    stopReason === 'time-limit' ||
    stopReason === 'yielded'
  )
}
