import { describe, expect, it } from 'vitest'
import type { ChatHistoryTurn } from '@shared/chat.types'
import {
  assembleModelContext,
  boundHistoryForStatelessProvider,
  historyBudgetTokens,
  MAX_MODEL_TOOL_RESULT_CHARS,
  projectHistoryForModel,
  rememberToolCallForModel,
  seedContextFromSnapshot
} from '../contextAssembler'
import { reservedNonHistoryTokens } from '@shared/contextBudget'

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

  it('caps the recall window by fraction and drops the overflow', async () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'A'.repeat(220) },
      { role: 'assistant', content: 'B'.repeat(250) },
      { role: 'user', content: 'C'.repeat(220) },
      { role: 'assistant', content: 'D'.repeat(250) }
    ]
    const summarize = (transcript: string): Promise<string> =>
      Promise.resolve(`Fixed summary: ${transcript.length} chars`)

    const greedy = await assembleModelContext({
      systemPrompt: 'system',
      history,
      contextSize: 2_000,
      countTokens,
      summarizeOlderTurns: summarize
    })
    const capped = await assembleModelContext({
      systemPrompt: 'system',
      history,
      contextSize: 2_000,
      countTokens,
      recallWindowFraction: 0.4,
      summarizeOlderTurns: summarize
    })

    expect(greedy.history.length).toBe(history.length)
    expect(capped.removedTurns).toBeGreaterThan(0)
    expect(capped.summarized).toBe(true)
    expect(capped.report.historyBudgetTokens).toBeLessThan(greedy.report.historyBudgetTokens)
    expect(capped.history.length).toBeLessThan(greedy.history.length)
    expect(capped.report.historyTokens).toBeLessThanOrEqual(capped.report.historyBudgetTokens)
  })

  it('applies the replay cap exactly once to the shared history budget', () => {
    const uncapped = historyBudgetTokens('system', 2_000, countTokens, 0, null)
    const capped = historyBudgetTokens('system', 2_000, countTokens, 0, 0.4)
    expect(capped).toBe(Math.floor(uncapped * 0.4))
    expect(uncapped).toBe(2_000 - countTokens('system') - reservedNonHistoryTokens(2_000))
  })

  it('treats an omitted or null recall window as uncapped for compatibility', async () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]
    const summarize = () => Promise.resolve('summary')

    const omitted = await assembleModelContext({
      systemPrompt: 'system',
      history,
      contextSize: 2_000,
      countTokens,
      summarizeOlderTurns: summarize
    })
    const nullCap = await assembleModelContext({
      systemPrompt: 'system',
      history,
      contextSize: 2_000,
      countTokens,
      recallWindowFraction: null,
      summarizeOlderTurns: summarize
    })

    expect(nullCap.report.historyBudgetTokens).toBe(omitted.report.historyBudgetTokens)
    expect(nullCap.history).toEqual(omitted.history)
  })

  it('reserves active tool-schema tokens before selecting verbatim history', async () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'a'.repeat(400) },
      { role: 'assistant', content: 'b'.repeat(400) },
      { role: 'user', content: 'c'.repeat(400) }
    ]
    const summarize = () => Promise.resolve('A bounded summary of the older tool-heavy turns.')
    const withoutTools = await assembleModelContext({
      systemPrompt: 'system',
      history,
      contextSize: 2_000,
      countTokens,
      summarizeOlderTurns: summarize
    })
    const withTools = await assembleModelContext({
      systemPrompt: 'system',
      history,
      contextSize: 2_000,
      countTokens,
      toolSchemaReserveTokens: 700,
      summarizeOlderTurns: summarize
    })

    expect(
      withoutTools.report.historyBudgetTokens - withTools.report.historyBudgetTokens
    ).toBeGreaterThanOrEqual(700)
    expect(withTools.history.length).toBeLessThan(withoutTools.history.length)
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
      { role: 'assistant', content: 'B'.repeat(250) },
      { role: 'user', content: 'C'.repeat(20) },
      { role: 'assistant', content: 'D'.repeat(20) }
    ]
    const summarizedCalls: Array<{ transcript: string; previous?: string }> = []

    const assembled = await assembleModelContext({
      systemPrompt: 'system',
      history,
      contextSize: 900,
      countTokens,
      summarizeOlderTurns: (transcript, previous) => {
        summarizedCalls.push({ transcript, previous })
        const summary = summarizedCalls.length === 1 ? 'S'.repeat(250) : 'Expanded summary'
        return Promise.resolve(summary)
      }
    })

    // One pass, where this needed two. The budget walk used to cut mid-pair and
    // keep `B` — an assistant reply to a question no longer in history — which
    // then had to be folded back on a second pass once the summary grew.
    // `splitHistoryByTokenBudget` now aligns the cut to a user turn, so the
    // orphan never survives the first split and there is nothing to fold back.
    expect(summarizedCalls).toHaveLength(1)
    expect(summarizedCalls[0].transcript).toContain('A'.repeat(220))
    expect(summarizedCalls[0].transcript).toContain('B'.repeat(250))
    // The outcome is unchanged, which is the point: same kept history, same
    // count removed, one fewer model call to get there.
    expect(assembled.history).toEqual([history[2], history[3]])
    expect(assembled.removedTurns).toBe(2)
  })

  it('continues folding until replacement-summary growth no longer overflows history', async () => {
    const history: ChatHistoryTurn[] = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: String(i).repeat(300)
    }))
    const summarySizes = [400, 700, 1_000]
    let summaryCall = 0
    const calls: Array<{ transcript: string; previous?: string }> = []

    const assembled = await assembleModelContext({
      systemPrompt: undefined,
      history,
      contextSize: 2_000,
      countTokens,
      summarizeOlderTurns: (transcript, previous) => {
        calls.push({ transcript, previous })
        return Promise.resolve(
          's'.repeat(summarySizes[Math.min(summaryCall++, summarySizes.length - 1)])
        )
      }
    })

    // More than one: a replacement summary that grows can push history back
    // over budget, and the pass has to keep folding until it stops.
    expect(summaryCall).toBeGreaterThan(1)
    // Each fold is a rolling update of the summary before it, not a fresh
    // summary of the whole older slice — that is what keeps the cost bounded.
    expect(calls[1].previous).toBe('s'.repeat(summarySizes[0]))
    expect(assembled.report.historyTokens).toBeLessThanOrEqual(assembled.report.historyBudgetTokens)
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

describe('boundHistoryForStatelessProvider', () => {
  it('keeps history verbatim and reports no omissions when it fits the budget', async () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]

    const bounded = await boundHistoryForStatelessProvider('be helpful', history, null, 10_000)

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

    const bounded = await boundHistoryForStatelessProvider(undefined, history, null, 1_000)

    // The request and its latest response form one active interaction. Even
    // when that interaction exceeds the synthetic budget, the ledger keeps it
    // together rather than replaying an orphaned response.
    expect(bounded.omittedTurns).toBe(0)
    expect(bounded.history).toEqual(history)
    expect(bounded.summarized).toBe(false)
  })

  it('holds back tool-schema tokens so they do not come out of the reply', async () => {
    // Regression test for a live failure: this path passed no tool-schema
    // reserve, so it planned history as if the whole window minus the system
    // prompt were available. The transport then added the schema surface on
    // top, and because schemas are fixed overhead that no compaction can
    // shrink, the shortfall landed on the answer — a 32K local project chat
    // measured 30,341 tokens of fixed input and got 1,628 tokens to reply in.
    const history: ChatHistoryTurn[] = [
      { id: 'm1', role: 'user', content: 'A'.repeat(2_000) },
      { id: 'm2', role: 'assistant', content: 'B'.repeat(2_000) },
      { id: 'm3', role: 'user', content: 'latest' }
    ]

    // Same history, same window: fits when schemas are free...
    const unreserved = await boundHistoryForStatelessProvider(undefined, history, null, 2_000)
    expect(unreserved.omittedTurns).toBe(0)

    // ...and is correctly compacted once their real cost is reserved.
    const reserved = await boundHistoryForStatelessProvider(
      undefined,
      history,
      null,
      2_000,
      undefined,
      undefined,
      { toolSchemaReserveTokens: 800 }
    )
    expect(reserved.omittedTurns).toBeGreaterThan(0)
    expect(reserved.history.at(-1)).toEqual(history[2])
  })

  it('applies a persisted snapshot before bounding, same as the local engine', async () => {
    const history: ChatHistoryTurn[] = [
      { id: 'm1', role: 'user', content: 'old request' },
      { id: 'm2', role: 'assistant', content: 'old answer' },
      { id: 'm3', role: 'user', content: 'latest request' }
    ]

    const bounded = await boundHistoryForStatelessProvider(
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
    // estimate `boundHistoryForStatelessProvider` actually uses (unlike
    // `assembleModelContext`'s own tests above, which inject a 1-char-per-
    // token `countTokens` and can use much smaller strings).
    const history: ChatHistoryTurn[] = [
      { id: 'm1', role: 'user', content: 'A'.repeat(2_000) },
      { id: 'm2', role: 'assistant', content: 'B'.repeat(2_000) },
      { id: 'm3', role: 'user', content: 'recent question' },
      { id: 'm4', role: 'assistant', content: 'recent answer' }
    ]

    const bounded = await boundHistoryForStatelessProvider(
      'system',
      history,
      null,
      700,
      (transcript) => Promise.resolve(`Summary: ${transcript.slice(0, 60)}`)
    )

    expect(bounded.summarized).toBe(true)
    expect(bounded.omittedTurns).toBeGreaterThan(0)
    expect(bounded.systemPrompt).toContain('Summary of earlier conversation')
    expect(bounded.history.at(-1)).toEqual(history.at(-1))
    expect(bounded.compactedThroughMessageId).toBeTruthy()
  })

  it('degrades to a bounded deterministic digest when the summarizer fails, instead of dropping', async () => {
    const history: ChatHistoryTurn[] = [
      { id: 'm1', role: 'user', content: 'a'.repeat(2_000) },
      { id: 'm2', role: 'assistant', content: 'b'.repeat(2_000) },
      { id: 'm3', role: 'user', content: 'latest' }
    ]

    const bounded = await boundHistoryForStatelessProvider(undefined, history, null, 700, () =>
      Promise.resolve(null)
    )

    // Old behavior dropped the older turns entirely on summarizer failure;
    // the rolling fold now keeps a hard-capped digest of them instead.
    expect(bounded.summarized).toBe(true)
    expect(bounded.summary).toBeDefined()
    expect(bounded.summary).toContain('a')
    // Bounded: nowhere near the raw 4,000-char transcript.
    expect(bounded.summary!.length).toBeLessThan(2_000)
    expect(bounded.history).toEqual([history[2]])
  })
})

describe('assembleModelContext — what the report says history cost', () => {
  /**
   * The report is what a developer reads out of the compaction log while
   * working out why a turn overflowed, so it has to measure history the same
   * way the budget that selected it did.
   */
  it('charges the per-message framing the budget charged', async () => {
    const history: ChatHistoryTurn[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]

    const assembled = await assembleModelContext({
      systemPrompt: '',
      history,
      contextSize: 2_000,
      countTokens,
      summarizeOlderTurns: () => Promise.resolve(null),
      messageFramingTokens: 10
    })

    // 'hi' + 'hello' = 7 characters, plus 10 framing tokens per message.
    expect(assembled.report.recentTurns).toBe(2)
    expect(assembled.report.historyTokens).toBe(27)
  })

  it('charges for a tool call that recorded a title and no result', async () => {
    // This used to count as zero: the sum read `result ?? detail ?? ''` and
    // never looked at the title, which the budget does charge for.
    const history: ChatHistoryTurn[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'c1',
            name: 'run_command',
            kind: 'command',
            status: 'running',
            title: 'Run: npm test'
          }
        ]
      }
    ]

    const assembled = await assembleModelContext({
      systemPrompt: '',
      history,
      contextSize: 2_000,
      countTokens,
      summarizeOlderTurns: () => Promise.resolve(null)
    })

    expect(assembled.report.historyTokens).toBe('Run: npm test'.length)
  })

  it('measures only the turns it kept, not the ones it dropped', async () => {
    // The budget and the report have to be talking about the same history, or
    // the log reads as though everything still fits.
    const history: ChatHistoryTurn[] = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn ${index} `.repeat(20)
    }))

    const assembled = await assembleModelContext({
      systemPrompt: 'be helpful',
      history,
      contextSize: 1_000,
      countTokens,
      summarizeOlderTurns: () => Promise.resolve(null),
      messageFramingTokens: 4
    })

    const keptCost = assembled.history.reduce((total, turn) => total + turn.content.length + 4, 0)
    expect(assembled.report.removedTurns).toBeGreaterThan(0)
    expect(assembled.report.historyTokens).toBe(keptCost)
  })
})
