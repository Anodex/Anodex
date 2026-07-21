import { describe, expect, it } from 'vitest'
import type { ContextBudgetUsage, GenerationStopReason } from '@shared/chat.types'
import { describeGenerationStop } from '../generationStopMessages'

const BUDGET: ContextBudgetUsage = {
  contextSize: 8_192,
  inputLimitTokens: 7_373,
  systemTokens: 1_000,
  promptTokens: 500,
  toolSchemaTokens: 200,
  fixedTokens: 4_037,
  reservedTokens: 256,
  requestedMaxOutputTokens: 2_048,
  effectiveMaxOutputTokens: 1_500,
  activeToolCount: 5,
  deferredToolCount: 2,
  toolRoutingApplied: true
}

describe('describeGenerationStop', () => {
  it('stays silent for a plain user Stop', () => {
    expect(describeGenerationStop('user', undefined, true)).toBeNull()
  })

  it('marks a recoverable stop with real content as bounded, not a failure', () => {
    const bounded: GenerationStopReason[] = [
      'context-shift-limit',
      'rounds-exhausted',
      'tool-limit',
      'token-limit',
      'time-limit',
      'yielded'
    ]
    for (const reason of bounded) {
      const note = describeGenerationStop(reason, BUDGET, true)
      expect(note).not.toBeNull()
      expect(note?.errorKind).toBe('bounded')
      expect(note?.error.length).toBeGreaterThan(0)
    }
  })

  it('treats context-limit as bounded only when real content came of it', () => {
    const withContent = describeGenerationStop('context-limit', BUDGET, true)
    const withoutContent = describeGenerationStop('context-limit', BUDGET, false)

    expect(withContent?.errorKind).toBe('bounded')
    expect(withoutContent?.errorKind).toBeUndefined()
  })

  it('treats fixed-context-limit as a genuine failure — nothing was ever produced', () => {
    const note = describeGenerationStop('fixed-context-limit', BUDGET, false)

    expect(note?.errorKind).toBeUndefined()
    expect(note?.error).toContain('4,037')
    expect(note?.error).toContain('7,373')
  })

  it('falls back to a generic fixed-context-limit message when no budget is available', () => {
    const note = describeGenerationStop('fixed-context-limit', undefined, false)

    expect(note?.errorKind).toBeUndefined()
    expect(note?.error).toContain('do not fit')
  })

  it('treats repeated-action guards as a genuine failure, not a benign budget', () => {
    for (const reason of ['loop-guard', 'no-progress'] as const) {
      const note = describeGenerationStop(reason, BUDGET, true)
      expect(note?.errorKind).toBeUndefined()
    }
  })

  it('reports the exact effective output limit when the budget carries one', () => {
    const note = describeGenerationStop('token-limit', BUDGET, true)

    expect(note?.error).toContain('1,500')
  })
})
