import { describe, expect, it } from 'vitest'
import type { Conversation } from '../conversation.types'
import { MAX_MODEL_TOOL_RESULT_CHARS } from '../contextBudget'
import { estimateProjectedContextUsage } from '../contextProjection'

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
})
