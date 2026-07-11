import { describe, expect, it } from 'vitest'
import type { ChatHistoryTurn } from '@shared/chat.types'
import {
  assembleModelContext,
  boundHistoryForCloudProvider,
  MAX_MODEL_TOOL_RESULT_CHARS,
  projectHistoryForModel,
  rememberToolCallForModel,
  seedContextFromSnapshot
} from '../contextAssembler'

const countTokens = (text: string): number => text.length

describe('projectHistoryForModel', () => {
  it('sanitizes assistant text and bounds remembered tool output', () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'make the change' },
      {
        role: 'assistant',
        content: 'Done.\n{"name": "edit_file", "arguments": {"path": "app.ts"}}',
        toolCalls: [
          {
            id: 't1',
            name: 'read_file',
            kind: 'read',
            title: 'Read app.ts',
            status: 'success',
            result: 'x'.repeat(MAX_MODEL_TOOL_RESULT_CHARS + 200)
          }
        ]
      }
    ]

    const projected = projectHistoryForModel(history)

    expect(projected[1].content).toBe('Done.')
    expect(projected[1].toolCalls?.[0].result).toContain('Anodex truncated')
    expect(projected[1].toolCalls?.[0].result?.length).toBeLessThan(
      MAX_MODEL_TOOL_RESULT_CHARS + 200
    )
  })
})

describe('rememberToolCallForModel', () => {
  it('returns a compact self-describing record for replay', () => {
    const remembered = rememberToolCallForModel({
      id: 't1',
      name: 'run_command',
      kind: 'command',
      title: 'Run npm test',
      status: 'success',
      result: 'passed'
    })

    expect(remembered).toBe('Run npm test\npassed')
  })
})

describe('assembleModelContext', () => {
  it('keeps projected history verbatim when it fits', async () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]

    const assembled = await assembleModelContext({
      systemPrompt: 'be helpful',
      history,
      contextSize: 2_000,
      countTokens,
      summarizeOlderTurns: () => Promise.reject(new Error('should not summarize'))
    })

    expect(assembled.history).toEqual(history)
    expect(assembled.removedTurns).toBe(0)
    expect(assembled.summarized).toBe(false)
  })

  it('summarizes older turns and keeps the latest turns within the final budget', async () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'A'.repeat(220) },
      { role: 'assistant', content: 'B'.repeat(180) },
      { role: 'user', content: 'recent question' },
      { role: 'assistant', content: 'recent answer' }
    ]

    const assembled = await assembleModelContext({
      systemPrompt: 'system',
      history,
      contextSize: 800,
      countTokens,
      summarizeOlderTurns: (transcript) => Promise.resolve(`Summary: ${transcript.slice(0, 60)}`)
    })

    expect(assembled.summarized).toBe(true)
    expect(assembled.removedTurns).toBeGreaterThan(0)
    expect(assembled.systemPrompt).toContain('Summary of earlier conversation')
    expect(assembled.history.at(-1)).toEqual(history.at(-1))
    expect(assembled.report.historyTokens).toBeLessThanOrEqual(assembled.report.historyBudgetTokens)
  })

  it('folds extra turns into the summary when the summary itself reduces recent-turn budget', async () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'A'.repeat(220) },
      { role: 'assistant', content: 'B'.repeat(160) },
      { role: 'user', content: 'C'.repeat(20) },
      { role: 'assistant', content: 'D'.repeat(20) }
    ]
    const summarizedTranscripts: string[] = []

    const assembled = await assembleModelContext({
      systemPrompt: 'system',
      history,
      contextSize: 900,
      countTokens,
      summarizeOlderTurns: (transcript) => {
        summarizedTranscripts.push(transcript)
        const summary = summarizedTranscripts.length === 1 ? 'S'.repeat(250) : 'Expanded summary'
        return Promise.resolve(summary)
      }
    })

    expect(summarizedTranscripts).toHaveLength(2)
    expect(summarizedTranscripts[1]).toContain('B'.repeat(160))
    expect(assembled.history).toEqual([history[2], history[3]])
    expect(assembled.removedTurns).toBe(2)
  })

  it('drops older turns without a summary when there is too little useful transcript', async () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'a'.repeat(20) },
      { role: 'assistant', content: 'b'.repeat(20) },
      { role: 'user', content: 'latest' }
    ]

    const assembled = await assembleModelContext({
      systemPrompt: undefined,
      history,
      contextSize: 520,
      countTokens,
      summarizeOlderTurns: () => Promise.resolve('unused')
    })

    expect(assembled.summarized).toBe(false)
    expect(assembled.systemPrompt).toBeUndefined()
    expect(assembled.history).toEqual([history[2]])
  })
})

describe('seedContextFromSnapshot', () => {
  it('injects a saved snapshot and keeps only turns after its boundary', () => {
    const history: ChatHistoryTurn[] = [
      { id: 'm1', role: 'user', content: 'old request' },
      { id: 'm2', role: 'assistant', content: 'old answer' },
      { id: 'm3', role: 'user', content: 'latest request' }
    ]

    const seeded = seedContextFromSnapshot('system', history, {
      activeSnapshot: {
        id: 'ctx1',
        createdAt: 1,
        reason: 'onLoad',
        throughMessageId: 'm2',
        removedTurns: 2,
        summary: 'User asked about old request and assistant answered.'
      }
    })

    expect(seeded.applied).toBe(true)
    expect(seeded.systemPrompt).toContain('Summary of earlier conversation')
    expect(seeded.history).toEqual([history[2]])
  })

  it('ignores a snapshot whose boundary no longer exists', () => {
    const history: ChatHistoryTurn[] = [{ id: 'm1', role: 'user', content: 'only turn' }]

    const seeded = seedContextFromSnapshot(undefined, history, {
      activeSnapshot: {
        id: 'ctx1',
        createdAt: 1,
        reason: 'onLoad',
        throughMessageId: 'missing',
        removedTurns: 2,
        summary: 'Old context.'
      }
    })

    expect(seeded.applied).toBe(false)
    expect(seeded.history).toEqual(history)
  })
})

describe('boundHistoryForCloudProvider', () => {
  it('keeps history verbatim and reports no omissions when it fits the budget', async () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]

    const bounded = await boundHistoryForCloudProvider('be helpful', history, null, 10_000)

    expect(bounded.systemPrompt).toBe('be helpful')
    expect(bounded.history).toEqual(history)
    expect(bounded.omittedTurns).toBe(0)
    expect(bounded.summarized).toBe(false)
  })

  it('drops (never summarizes) older turns that do not fit the estimated budget, with no summarizer', async () => {
    const history: ChatHistoryTurn[] = [
      { id: 'm1', role: 'user', content: 'A'.repeat(3_000) },
      { id: 'm2', role: 'assistant', content: 'latest' }
    ]

    const bounded = await boundHistoryForCloudProvider(undefined, history, null, 1_000)

    expect(bounded.omittedTurns).toBe(1)
    expect(bounded.history).toEqual([history[1]])
    expect(bounded.summarized).toBe(false)
  })

  it('applies a persisted snapshot before bounding, same as the local engine', async () => {
    const history: ChatHistoryTurn[] = [
      { id: 'm1', role: 'user', content: 'old request' },
      { id: 'm2', role: 'assistant', content: 'old answer' },
      { id: 'm3', role: 'user', content: 'latest request' }
    ]

    const bounded = await boundHistoryForCloudProvider(
      'system',
      history,
      {
        activeSnapshot: {
          id: 'ctx1',
          createdAt: 1,
          reason: 'onLoad',
          throughMessageId: 'm2',
          removedTurns: 2,
          summary: 'User asked about old request and assistant answered.'
        }
      },
      10_000
    )

    expect(bounded.systemPrompt).toContain('Summary of earlier conversation')
    expect(bounded.history).toEqual([history[2]])
    expect(bounded.omittedTurns).toBe(0)
  })

  it('summarizes overflow via the supplied summarizer instead of dropping it', async () => {
    // Character counts here are calibrated for the real ~4-chars-per-token
    // estimate `boundHistoryForCloudProvider` actually uses (unlike
    // `assembleModelContext`'s own tests above, which inject a 1-char-per-
    // token `countTokens` and can use much smaller strings).
    const history: ChatHistoryTurn[] = [
      { id: 'm1', role: 'user', content: 'A'.repeat(2_000) },
      { id: 'm2', role: 'assistant', content: 'B'.repeat(2_000) },
      { id: 'm3', role: 'user', content: 'recent question' },
      { id: 'm4', role: 'assistant', content: 'recent answer' }
    ]

    const bounded = await boundHistoryForCloudProvider('system', history, null, 700, (transcript) =>
      Promise.resolve(`Summary: ${transcript.slice(0, 60)}`)
    )

    expect(bounded.summarized).toBe(true)
    expect(bounded.omittedTurns).toBeGreaterThan(0)
    expect(bounded.systemPrompt).toContain('Summary of earlier conversation')
    expect(bounded.history.at(-1)).toEqual(history.at(-1))
    expect(bounded.compactedThroughMessageId).toBeTruthy()
  })

  it('falls back to dropping when the summarizer fails or returns a degenerate result', async () => {
    const history: ChatHistoryTurn[] = [
      { id: 'm1', role: 'user', content: 'a'.repeat(2_000) },
      { id: 'm2', role: 'assistant', content: 'b'.repeat(2_000) },
      { id: 'm3', role: 'user', content: 'latest' }
    ]

    const bounded = await boundHistoryForCloudProvider(undefined, history, null, 700, () =>
      Promise.resolve(null)
    )

    expect(bounded.summarized).toBe(false)
    expect(bounded.history).toEqual([history[2]])
  })
})
