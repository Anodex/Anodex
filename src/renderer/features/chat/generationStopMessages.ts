import type { ContextBudgetUsage, GenerationStopReason } from '@shared/chat.types'

export interface GenerationStopNote {
  error: string
  /** See `ChatMessage.errorKind`'s doc comment. Omitted means a genuine failure. */
  errorKind?: 'bounded'
}

/**
 * Maps a non-user generation stop reason to the message a message bubble
 * should show, and whether it's a bounded, content-preserving note (rendered
 * calmly) or a genuine failure (rendered as a red error). Returns `null` for
 * `'user'` — a plain Stop stays silent, no message at all, same as before
 * this function existed.
 */
export function describeGenerationStop(
  stopReason: GenerationStopReason,
  contextBudget: ContextBudgetUsage | undefined,
  hasContent: boolean
): GenerationStopNote | null {
  switch (stopReason) {
    case 'user':
      return null
    case 'context-limit':
      // Only genuinely bounded (not broken) when something real came of it —
      // an empty reply here means the turn produced nothing usable.
      return hasContent
        ? {
            error:
              'This reply stopped early — the conversation ran out of context space. The text above is everything produced before that point.',
            errorKind: 'bounded'
          }
        : {
            error:
              'This reply ran out of context space while working. Anodex compacted what it could, but the turn still reached the model’s hard limit.'
          }
    case 'context-shift-limit':
      return {
        error:
          'This reply reached its bounded context-compaction budget. The text and completed tool work above were preserved.',
        errorKind: 'bounded'
      }
    case 'fixed-context-limit':
      // Nothing was ever produced here (the pre-flight fit check failed
      // before generation started) — a real failure, not a bounded stop.
      return {
        error: contextBudget
          ? `The model could not start because its fixed instructions and active tool definitions need ${contextBudget.fixedTokens.toLocaleString()} tokens, but only ${contextBudget.inputLimitTokens.toLocaleString()} fit before reply space. Anodex already deferred ${contextBudget.deferredToolCount} tool${contextBudget.deferredToolCount === 1 ? '' : 's'}.`
          : 'The model could not start because its fixed instructions and active tool definitions do not fit in the current context window.'
      }
    case 'rounds-exhausted':
      return {
        error:
          'This reply reached its provider-round budget before the task completed. The text and completed tool work above were preserved.',
        errorKind: 'bounded'
      }
    case 'tool-limit':
      return {
        error:
          'This reply reached its tool-call budget. The text and completed tool work above were preserved.',
        errorKind: 'bounded'
      }
    case 'token-limit':
      return {
        error: contextBudget?.effectiveMaxOutputTokens
          ? `This reply reached its safe local output limit of ${contextBudget.effectiveMaxOutputTokens.toLocaleString()} tokens. The text and completed tool work above were preserved.`
          : 'This reply reached its local output-token limit. The text and completed tool work above were preserved.',
        errorKind: 'bounded'
      }
    case 'time-limit':
      return {
        error:
          'This reply reached its 15-minute turn budget. The text and completed tool work above were preserved.',
        errorKind: 'bounded'
      }
    case 'loop-guard':
    case 'no-progress':
      // Repetition without progress is a real malfunction worth flagging
      // prominently, not a benign size/time/tool budget.
      return { error: 'This reply was stopped after repeating actions without making progress.' }
    case 'yielded':
      return {
        error: 'This reply saved its progress and yielded before completing the full task.',
        errorKind: 'bounded'
      }
  }
}
