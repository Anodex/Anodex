import { describe, expect, it } from 'vitest'
import type { Conversation } from '../conversation.types'
import { MAX_MODEL_TOOL_RESULT_CHARS, reservedNonHistoryTokens } from '../contextBudget'
import { estimateProjectedContextUsage, planManualContextCompaction } from '../contextProjection'

function conversation(messages: Conversation['messages']): Conversation {
  return {
    id: 'c1',
    projectId: null,
    title: 'Context test',
    messages,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('estimateProjectedContextUsage', () => {
  it('accounts for system prompt, recent history, and reserved context', () => {
    const usage = estimateProjectedContextUsage({
      conversation: conversation([
        { id: 'm1', role: 'user', content: 'hello', createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'hi there', createdAt: 2 }
      ]),
      contextSize: 2_000,
      systemPrompt: 'be helpful'
    })

    expect(usage.usedTokens).toBeGreaterThan(usage.reservedTokens)
    expect(usage.systemTokens).toBeGreaterThan(0)
    expect(usage.recentTurns).toBe(2)
    expect(usage.snapshotApplied).toBe(false)
  })

  it('uses exact local system/tool accounting when the engine reports it', () => {
    const usage = estimateProjectedContextUsage({
      conversation: conversation([
        { id: 'm1', role: 'user', content: 'inspect the project', createdAt: 1 }
      ]),
      contextSize: 8_192,
      systemPrompt: 'this renderer estimate should be replaced',
      fixedContext: {
        contextSize: 8_192,
        inputLimitTokens: 7_373,
        systemTokens: 1_200,
        promptTokens: 20,
        toolSchemaTokens: 2_400,
        fixedTokens: 3_620,
        reservedTokens: 819,
        activeToolCount: 9,
        deferredToolCount: 31,
        toolRoutingApplied: true
      }
    })

    expect(usage.systemTokens).toBe(1_200)
    expect(usage.toolSchemaTokens).toBe(2_400)
    expect(usage.reservedTokens).toBe(819)
    expect(usage.activeToolCount).toBe(9)
    expect(usage.deferredToolCount).toBe(31)
    expect(usage.toolRoutingApplied).toBe(true)
  })

  it('applies a snapshot and only estimates turns after its boundary', () => {
    const base = conversation([
      { id: 'm1', role: 'user', content: 'old request', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'old answer', createdAt: 2 },
      { id: 'm3', role: 'user', content: 'latest request', createdAt: 3 }
    ])
    base.context = {
      activeSnapshot: {
        id: 'ctx1',
        createdAt: 4,
        reason: 'onLoad',
        throughMessageId: 'm2',
        removedTurns: 2,
        summary: 'The user asked an old request and the assistant answered.'
      }
    }

    const usage = estimateProjectedContextUsage({
      conversation: base,
      contextSize: 2_000
    })

    expect(usage.snapshotApplied).toBe(true)
    expect(usage.snapshotTurns).toBe(2)
    expect(usage.recentTurns).toBe(1)
    expect(usage.snapshotTokens).toBeGreaterThan(0)
  })

  it('ignores a snapshot when its boundary cannot be found', () => {
    const base = conversation([{ id: 'm1', role: 'user', content: 'only turn', createdAt: 1 }])
    base.context = {
      activeSnapshot: {
        id: 'ctx1',
        createdAt: 2,
        reason: 'onLoad',
        throughMessageId: 'missing',
        removedTurns: 5,
        summary: 'Unusable summary.'
      }
    }

    const usage = estimateProjectedContextUsage({
      conversation: base,
      contextSize: 2_000
    })

    expect(usage.snapshotApplied).toBe(false)
    expect(usage.recentTurns).toBe(1)
  })

  it('reports older turns that would compact when projected history exceeds budget', () => {
    const usage = estimateProjectedContextUsage({
      conversation: conversation([
        { id: 'm1', role: 'user', content: 'a'.repeat(1_500), createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'b'.repeat(1_500), createdAt: 2 },
        { id: 'm3', role: 'user', content: 'latest', createdAt: 3 }
      ]),
      contextSize: 620
    })

    expect(usage.recentTurns).toBe(1)
    expect(usage.omittedTurns).toBe(2)
  })

  it('bounds old tool output before estimating replay cost', () => {
    const shortOutput = 'x'.repeat(100)
    const hugeOutput = 'x'.repeat(MAX_MODEL_TOOL_RESULT_CHARS * 10)
    const baseMessage = {
      id: 'm1',
      role: 'assistant' as const,
      content: 'Read it.',
      createdAt: 1
    }

    const shortUsage = estimateProjectedContextUsage({
      conversation: conversation([
        {
          ...baseMessage,
          toolCalls: [
            {
              id: 't1',
              name: 'read_file',
              kind: 'read',
              title: 'Read file',
              status: 'success',
              result: shortOutput
            }
          ]
        }
      ]),
      contextSize: 4_000
    })
    const hugeUsage = estimateProjectedContextUsage({
      conversation: conversation([
        {
          ...baseMessage,
          toolCalls: [
            {
              id: 't1',
              name: 'read_file',
              kind: 'read',
              title: 'Read file',
              status: 'success',
              result: hugeOutput
            }
          ]
        }
      ]),
      contextSize: 4_000
    })

    expect(hugeUsage.historyTokens - shortUsage.historyTokens).toBeLessThan(
      MAX_MODEL_TOOL_RESULT_CHARS
    )
  })

  it('mirrors the engine recall-window cap on the projected history budget', () => {
    const usage = estimateProjectedContextUsage({
      conversation: conversation([
        { id: 'm1', role: 'user', content: 'a'.repeat(400), createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'b'.repeat(400), createdAt: 2 },
        { id: 'm3', role: 'user', content: 'latest', createdAt: 3 }
      ]),
      contextSize: 2_000,
      systemPrompt: 'system',
      recallWindowFraction: 0.4
    })

    const greedy = estimateProjectedContextUsage({
      conversation: conversation([
        { id: 'm1', role: 'user', content: 'a'.repeat(400), createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'b'.repeat(400), createdAt: 2 },
        { id: 'm3', role: 'user', content: 'latest', createdAt: 3 }
      ]),
      contextSize: 2_000,
      systemPrompt: 'system'
    })

    expect(usage.historyBudgetTokens).toBe(Math.floor(greedy.historyBudgetTokens * 0.4))
    expect(usage.historyBudgetTokens).toBeLessThan(greedy.historyBudgetTokens)
    expect(greedy.historyBudgetTokens).toBe(
      2_000 - greedy.systemTokens - reservedNonHistoryTokens(2_000)
    )
  })

  it('treats a null replay cap as greedy full recall', () => {
    const capped = estimateProjectedContextUsage({
      conversation: conversation([
        { id: 'm1', role: 'user', content: 'hi', createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'hello', createdAt: 2 }
      ]),
      contextSize: 2_000,
      recallWindowFraction: null
    })
    const greedy = estimateProjectedContextUsage({
      conversation: conversation([
        { id: 'm1', role: 'user', content: 'hi', createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'hello', createdAt: 2 }
      ]),
      contextSize: 2_000
    })

    expect(capped.historyBudgetTokens).toBe(greedy.historyBudgetTokens)
  })

  it('charges for thinking tokens that occupy the KV cache', () => {
    const userTurn = { id: 'm1', role: 'user' as const, content: 'hard problem', createdAt: 1 }
    const plain = estimateProjectedContextUsage({
      conversation: conversation([
        userTurn,
        { id: 'm2', role: 'assistant' as const, content: 'Short answer.', createdAt: 2 }
      ]),
      contextSize: 4_000
    })
    const withThinking = estimateProjectedContextUsage({
      conversation: conversation([
        userTurn,
        {
          id: 'm2',
          role: 'assistant' as const,
          content: 'Short answer.',
          thinking: 'r'.repeat(4_000),
          createdAt: 2
        }
      ]),
      contextSize: 4_000
    })

    expect(withThinking.historyTokens).toBeGreaterThan(plain.historyTokens + 900)
  })

  it('never opens the kept slice with an orphaned assistant reply', () => {
    // `a`'s 250-token cost exceeds the 108-token budget, so the walk keeps
    // only `answer` + `latest` — the engine (and this mirror) then drops the
    // leading assistant reply since it answers a question the model can no
    // longer see.
    const usage = estimateProjectedContextUsage({
      conversation: conversation([
        { id: 'm1', role: 'user', content: 'x'.repeat(1_000), createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'answer', createdAt: 2 },
        { id: 'm3', role: 'user', content: 'latest', createdAt: 3 }
      ]),
      contextSize: 620
    })

    expect(usage.recentTurns).toBe(1)
    expect(usage.omittedTurns).toBe(2)
    expect(usage.historyTokens).toBe(2)
  })

  it('caps a single oversized kept turn to the budget', () => {
    const usage = estimateProjectedContextUsage({
      conversation: conversation([
        {
          id: 'm1',
          role: 'assistant' as const,
          content: 'Done.',
          createdAt: 1,
          toolCalls: [
            {
              id: 't1',
              name: 'read_file',
              kind: 'read',
              title: 'Read file',
              status: 'success',
              result: 'x'.repeat(2_000)
            }
          ]
        }
      ]),
      contextSize: 620
    })

    expect(usage.recentTurns).toBe(1)
    expect(usage.historyTokens).toBeGreaterThan(0)
    // Uncapped, the tool result alone would cost ~300 tokens; the cap trims it
    // to a "result omitted" notice so the projected replay actually fits.
    expect(usage.historyTokens).toBeLessThan(50)
  })
})

describe('planManualContextCompaction', () => {
  it('keeps the newest turns exact and compacts older turns', () => {
    const history = [
      { id: 'm1', role: 'user' as const, content: 'old one' },
      { id: 'm2', role: 'assistant' as const, content: 'old two' },
      { id: 'm3', role: 'user' as const, content: 'recent one' },
      { id: 'm4', role: 'assistant' as const, content: 'recent two' }
    ]

    const plan = planManualContextCompaction(history, null, 2)

    expect(plan?.older).toEqual([history[0], history[1]])
    expect(plan?.recent).toEqual([history[2], history[3]])
    expect(plan?.compactedThroughMessageId).toBe('m2')
    expect(plan?.compactedTurns).toBe(2)
    expect(plan?.previousRemovedTurns).toBe(0)
  })

  it('extends an existing snapshot instead of re-summarizing turns it already covers', () => {
    const history = [
      { id: 'm1', role: 'user' as const, content: 'already compacted' },
      { id: 'm2', role: 'assistant' as const, content: 'snapshot boundary' },
      { id: 'm3', role: 'user' as const, content: 'new old turn' },
      { id: 'm4', role: 'assistant' as const, content: 'keep exact' }
    ]

    const plan = planManualContextCompaction(
      history,
      {
        activeSnapshot: {
          id: 'ctx1',
          createdAt: 1,
          reason: 'manual',
          throughMessageId: 'm2',
          removedTurns: 2,
          summary: 'Prior compacted context.'
        }
      },
      1
    )

    expect(plan?.older).toEqual([history[2]])
    expect(plan?.recent).toEqual([history[3]])
    expect(plan?.previousSummary).toBe('Prior compacted context.')
    expect(plan?.previousRemovedTurns).toBe(2)
    expect(plan?.compactedThroughMessageId).toBe('m3')
  })

  it('returns null when there are not enough exact turns to compact', () => {
    const plan = planManualContextCompaction(
      [
        { id: 'm1', role: 'user', content: 'one' },
        { id: 'm2', role: 'assistant', content: 'two' }
      ],
      null,
      6
    )

    expect(plan).toBeNull()
  })
})
