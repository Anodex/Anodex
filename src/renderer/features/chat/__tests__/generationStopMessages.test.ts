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

  it('explains a turn that could not start by the reply room it was left', () => {
    // The live 4K refusal read "need 2,672 tokens, but only 3,584 fit", which
    // compares the wrong pair: 2,672 is the smaller number, so the sentence
    // contradicted itself and never named what actually ran out.
    const note = describeGenerationStop(
      'fixed-context-limit',
      {
        ...BUDGET,
        contextSize: 4_096,
        inputLimitTokens: 3_584,
        fixedTokens: 2_672,
        effectiveMaxOutputTokens: 912,
        deferredToolCount: 35
      },
      false
    )

    expect(note?.error).toContain('2,672 of the 3,584')
    expect(note?.error).toContain('leaving only 912 to reply in')
    expect(note?.error).toContain('35 tools')
    expect(note?.error).toContain('Raise the context size')
  })

  it('derives the remaining reply room when the transport reported none', () => {
    const { effectiveMaxOutputTokens: _omitted, ...withoutCeiling } = BUDGET
    const note = describeGenerationStop('fixed-context-limit', withoutCeiling, false)

    // 7,373 - 4,037
    expect(note?.error).toContain('3,336')
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

  it('leads a provider failure with the provider’s own message', () => {
    const note = describeGenerationStop('provider-error', BUDGET, true, '429 rate limit exceeded.')

    // Never bounded: nothing budgeted this stop, so it stays a red error even
    // though the work above it survived. And the detail has to come through —
    // "rate limited" and "invalid request" call for opposite responses.
    expect(note?.errorKind).toBeUndefined()
    expect(note?.error).toContain('429 rate limit exceeded.')
  })

  it('still explains a provider failure that arrived without a message', () => {
    const note = describeGenerationStop('provider-error', BUDGET, true)

    expect(note?.errorKind).toBeUndefined()
    expect(note?.error).toContain('provider failed')
  })

  it('keeps a stalled runtime calm only while it has work to show for it', () => {
    expect(describeGenerationStop('runtime-stalled', BUDGET, true)?.errorKind).toBe('bounded')
    expect(describeGenerationStop('runtime-stalled', BUDGET, false)?.errorKind).toBeUndefined()
  })
})
