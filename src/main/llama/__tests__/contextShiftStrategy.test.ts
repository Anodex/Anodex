import { describe, expect, it, vi } from 'vitest'
import type { ChatHistoryItem, ChatModelFunctionCall } from 'node-llama-cpp'
import {
  createBoundedContextShiftStrategy,
  findLastExchangeStartIndex,
  fullItemCost,
  renderChatHistoryItemsForSummary,
  trimNewestExchangeToFit,
  type BoundedContextShiftMetadata
} from '../contextShiftStrategy'

/** Deterministic fake tokenizer: 1 "token" per character, matching compaction.test.ts's convention. */
const tokenizer = (text: string): unknown[] => Array.from(text)
const countTokens = (text: string): number => text.length
const stringifySystemText = (text: unknown): string =>
  typeof text === 'string' ? text : String(text)

function functionCall(
  name: string,
  params: unknown,
  result: string,
  rawCall?: unknown
): ChatModelFunctionCall {
  const call: ChatModelFunctionCall = { type: 'functionCall', name, params, result }
  if (rawCall !== undefined) call.rawCall = rawCall as ChatModelFunctionCall['rawCall']
  return call
}

function summarizeMock(impl?: (transcript: string, previous?: string) => Promise<string | null>) {
  return vi.fn(impl ?? (() => Promise.resolve('chunk summary')))
}

describe('renderChatHistoryItemsForSummary', () => {
  it('renders system/user/model items as a plain transcript', () => {
    const items: ChatHistoryItem[] = [
      { type: 'system', text: 'be helpful' },
      { type: 'user', text: 'hi' },
      { type: 'model', response: ['hello'] }
    ]
    expect(renderChatHistoryItemsForSummary(items, stringifySystemText)).toBe(
      'System: be helpful\nUser: hi\nAssistant: hello'
    )
  })

  it('renders function calls with their name, params, and a result preview', () => {
    const items: ChatHistoryItem[] = [
      {
        type: 'model',
        response: [
          functionCall('fetch_url', { url: 'https://example.com/bees' }, 'Bees sting because...')
        ]
      }
    ]
    expect(renderChatHistoryItemsForSummary(items, stringifySystemText)).toBe(
      'Assistant: [called fetch_url({"url":"https://example.com/bees"}) → Bees sting because...]'
    )
  })
})

describe('findLastExchangeStartIndex', () => {
  it('finds the most recent user item', () => {
    const items: ChatHistoryItem[] = [
      { type: 'user', text: 'first' },
      { type: 'model', response: ['a'] },
      { type: 'user', text: 'second' },
      { type: 'model', response: ['b'] }
    ]
    expect(findLastExchangeStartIndex(items)).toBe(2)
  })

  it('returns 0 when there is no user item at all', () => {
    const items: ChatHistoryItem[] = [{ type: 'model', response: ['a'] }]
    expect(findLastExchangeStartIndex(items)).toBe(0)
  })
})

describe('fullItemCost', () => {
  it('counts the complete result, not a 300-char preview', () => {
    const item: ChatHistoryItem = {
      type: 'model',
      response: [functionCall('fetch_url', { url: 'https://example.com' }, 'r'.repeat(4_000))]
    }
    // The preview-based transcript render would cost ~300 for the result;
    // the full cost must reflect all 4,000 chars.
    expect(fullItemCost(item, countTokens)).toBeGreaterThan(4_000)
  })

  it('counts large params and rawCall, not just the result', () => {
    const bigContent = 'c'.repeat(5_000)
    const withParams: ChatHistoryItem = {
      type: 'model',
      response: [functionCall('write_file', { path: 'a.ts', content: bigContent }, 'ok')]
    }
    expect(fullItemCost(withParams, countTokens)).toBeGreaterThan(5_000)

    const withRawCall: ChatHistoryItem = {
      type: 'model',
      response: [functionCall('write_file', { path: 'a.ts' }, 'ok', { raw: 'x'.repeat(3_000) })]
    }
    expect(fullItemCost(withRawCall, countTokens)).toBeGreaterThan(3_000)
  })
})

describe('trimNewestExchangeToFit', () => {
  it('leaves history untouched when already under budget', () => {
    const items: ChatHistoryItem[] = [
      { type: 'model', response: [functionCall('web_search', {}, 'short')] }
    ]
    expect(trimNewestExchangeToFit(items, 1_000, countTokens)).toEqual(items)
  })

  it('trims the oldest function-call results first, keeping name and params', () => {
    const items: ChatHistoryItem[] = [
      {
        type: 'model',
        response: [
          functionCall('web_search', { query: 'bee stings' }, 'y'.repeat(500)),
          functionCall('fetch_url', { url: 'https://example.com/a' }, 'z'.repeat(500))
        ]
      }
    ]
    const result = trimNewestExchangeToFit(items, 300, countTokens)
    const response = (result[0] as { response: ChatModelFunctionCall[] }).response
    expect(response[0].result).not.toBe('y'.repeat(500))
    expect(response[0].name).toBe('web_search')
    expect(response[0].params).toEqual({ query: 'bee stings' })
    expect(response[1].params).toEqual({ url: 'https://example.com/a' })
  })

  it('actually fits the budget measured by FULL cost when results dominate', () => {
    const items: ChatHistoryItem[] = [
      { type: 'user', text: 'investigate' },
      {
        type: 'model',
        response: Array.from({ length: 40 }, (_, i) =>
          functionCall('fetch_url', { url: `https://example.com/${i}` }, 'x'.repeat(4_000))
        )
      }
    ]
    const budget = 20_000
    const result = trimNewestExchangeToFit(items, budget, countTokens)
    const total = result.reduce((sum, item) => sum + fullItemCost(item, countTokens), 0)
    expect(total).toBeLessThanOrEqual(budget)
    // Identifiers survive on every trimmed call.
    const response = (result[1] as { response: ChatModelFunctionCall[] }).response
    expect(response[0].params).toEqual({ url: 'https://example.com/0' })
  })

  it('compacts oversized params and clears rawCall when results alone are not enough', () => {
    const bigContent = 'const x = 1\n'.repeat(1_000)
    const items: ChatHistoryItem[] = [
      {
        type: 'model',
        response: [
          functionCall('write_file', { path: 'src/big.ts', content: bigContent }, 'ok', {
            raw: 'raw call text'
          })
        ]
      }
    ]
    const result = trimNewestExchangeToFit(items, 800, countTokens)
    const call = (result[0] as { response: ChatModelFunctionCall[] }).response[0]
    const params = call.params as { path: string; content: string }
    // Small identifying field kept verbatim; large content field compacted.
    expect(params.path).toBe('src/big.ts')
    expect(params.content.length).toBeLessThan(bigContent.length)
    expect(params.content).toContain('content omitted')
    // Stale rawCall cleared so the wrapper renders from the compacted params.
    expect(call.rawCall).toBeUndefined()
  })

  it('recursively compacts oversized strings inside nested params', () => {
    const nestedContent = 'payload'.repeat(2_000)
    const items: ChatHistoryItem[] = [
      {
        type: 'model',
        response: [
          functionCall(
            'nested_tool',
            { path: 'src/data.json', payload: { rows: [{ content: nestedContent }] } },
            'ok',
            { raw: nestedContent }
          )
        ]
      }
    ]

    const result = trimNewestExchangeToFit(items, 1_000, countTokens)
    const call = (result[0] as { response: ChatModelFunctionCall[] }).response[0]
    const params = call.params as {
      path: string
      payload: { rows: Array<{ content: string }> }
    }
    expect(params.path).toBe('src/data.json')
    expect(params.payload.rows[0].content).toContain('content omitted')
    expect(params.payload.rows[0].content.length).toBeLessThan(nestedContent.length)
    expect(call.rawCall).toBeUndefined()
    expect(
      result.reduce((sum, item) => sum + fullItemCost(item, countTokens), 0)
    ).toBeLessThanOrEqual(1_000)
  })

  it('never mutates the input array in place', () => {
    const items: ChatHistoryItem[] = [
      {
        type: 'model',
        response: [functionCall('write_file', { content: 'y'.repeat(900) }, 'z'.repeat(500))]
      }
    ]
    const original: unknown = JSON.parse(JSON.stringify(items))
    trimNewestExchangeToFit(items, 10, countTokens)
    expect(items).toEqual(original)
  })

  it('drops irreducible old calls without inserting assistant-text compaction markers', () => {
    const items: ChatHistoryItem[] = [
      { type: 'user', text: 'audit the project' },
      {
        type: 'model',
        response: Array.from({ length: 20 }, (_, i) =>
          functionCall('read_file', { path: `src/file-${i}.ts` }, 'x'.repeat(500))
        )
      }
    ]

    const result = trimNewestExchangeToFit(items, 100, countTokens)
    const model = result.find((item) => item.type === 'model')
    expect(model?.type).toBe('model')
    expect(model?.type === 'model' ? model.response.filter(isString) : []).toEqual([])
    expect(
      result.reduce((sum, item) => sum + fullItemCost(item, countTokens), 0)
    ).toBeLessThanOrEqual(100)
  })

  it('falls back to shrinking the user message text when nothing else is trimmable (pass 5)', () => {
    // Regression: a fresh turn with no prior tool calls at all — passes 1-4
    // only ever touch `model` items, so without pass 5 this returned its
    // input byte-identical no matter how far over budget, guaranteeing
    // node-llama-cpp's own re-verification rejected it. Reproduced live: a
    // project chat's very first message at a 4,096-token context.
    const items: ChatHistoryItem[] = [
      { type: 'user', text: 'y'.repeat(2_000) },
      { type: 'model', response: [] }
    ]
    const result = trimNewestExchangeToFit(items, 200, countTokens)
    const userItem = result[0] as { type: 'user'; text: string }
    expect(userItem.text.length).toBeLessThan(2_000)
    expect(userItem.text).toContain('[message truncated to fit context]')
    const total = result.reduce((sum, item) => sum + fullItemCost(item, countTokens), 0)
    expect(total).toBeLessThanOrEqual(200)
  })
})

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

describe('createBoundedContextShiftStrategy', () => {
  it('reads the current tool-schema reserve on every invocation of a reused strategy', async () => {
    let schemaReserve = 0
    const strategy = createBoundedContextShiftStrategy({
      summarize: summarizeMock(),
      stringifySystemText,
      getToolSchemaReserveTokens: () => schemaReserve
    })
    const chatHistory: ChatHistoryItem[] = [
      { type: 'user', text: 'u'.repeat(1_500) },
      { type: 'model', response: [] }
    ]

    const first = await strategy({
      chatHistory,
      maxTokensCount: 4_000,
      tokenizer,
      lastShiftMetadata: null
    })
    schemaReserve = 2_500
    const second = await strategy({
      chatHistory,
      maxTokensCount: 4_000,
      tokenizer,
      lastShiftMetadata: null
    })

    const firstUser = first.chatHistory.find((item) => item.type === 'user')
    const secondUser = second.chatHistory.find((item) => item.type === 'user')
    expect(firstUser?.type === 'user' ? firstUser.text.length : 0).toBe(1_500)
    expect(secondUser?.type === 'user' ? secondUser.text.length : 0).toBeLessThan(1_500)
  })

  it('summarizes whole older exchanges but keeps the newest exchange verbatim when it fits', async () => {
    const summarize = summarizeMock(() => Promise.resolve('summary of the first exchange'))
    const strategy = createBoundedContextShiftStrategy({ summarize, stringifySystemText })

    const chatHistory: ChatHistoryItem[] = [
      { type: 'system', text: 'be helpful' },
      { type: 'user', text: 'x'.repeat(200) },
      { type: 'model', response: ['y'.repeat(200)] },
      { type: 'user', text: 'newest question' },
      { type: 'model', response: ['newest answer'] }
    ]

    const result = await strategy({
      chatHistory,
      maxTokensCount: 700,
      tokenizer,
      lastShiftMetadata: null
    })

    expect(summarize).toHaveBeenCalledOnce()
    expect(result.metadata.summary).toContain('summary of the first exchange')
    expect(result.metadata.coveredItemCount).toBe(2)
    expect(result.chatHistory[0]).toMatchObject({ type: 'system' })
    expect((result.chatHistory[0] as { text: string }).text).toContain(
      'summary of the first exchange'
    )
    expect(result.chatHistory.slice(1)).toEqual([
      { type: 'user', text: 'newest question' },
      { type: 'model', response: ['newest answer'] }
    ])
  })

  it('falls back to a bounded deterministic digest when summarization fails', async () => {
    const summarize = summarizeMock(() => Promise.resolve(null))
    const strategy = createBoundedContextShiftStrategy({ summarize, stringifySystemText })

    const chatHistory: ChatHistoryItem[] = [
      { type: 'system', text: 'be helpful' },
      { type: 'user', text: 'x'.repeat(200) },
      {
        type: 'model',
        response: [functionCall('fetch_url', { url: 'https://example.com/x' }, 'z'.repeat(200))]
      },
      { type: 'user', text: 'newest question' },
      { type: 'model', response: ['newest answer'] }
    ]

    const result = await strategy({
      chatHistory,
      maxTokensCount: 700,
      tokenizer,
      lastShiftMetadata: null
    })
    expect((result.chatHistory[0] as { text: string }).text).toContain('https://example.com/x')
  })

  it('does not re-summarize exchanges already covered by the cursor on a repeat shift', async () => {
    const summarize = summarizeMock(() => Promise.resolve('rolling summary'))
    const strategy = createBoundedContextShiftStrategy({ summarize, stringifySystemText })
    const chatHistory: ChatHistoryItem[] = [
      { type: 'system', text: 'be helpful' },
      { type: 'user', text: 'x'.repeat(300) },
      { type: 'model', response: ['y'.repeat(300)] },
      { type: 'user', text: 'newest' },
      { type: 'model', response: ['answer'] }
    ]

    const first = await strategy({
      chatHistory,
      maxTokensCount: 800,
      tokenizer,
      lastShiftMetadata: null
    })
    expect(summarize).toHaveBeenCalledOnce()

    // Same canonical history again (nothing new since the last shift): the
    // cursor must prevent any further summarizer calls, and the summary must
    // not grow by re-appending the same content.
    const second = await strategy({
      chatHistory,
      maxTokensCount: 800,
      tokenizer,
      lastShiftMetadata: first.metadata
    })
    expect(summarize).toHaveBeenCalledOnce()
    expect(second.metadata.summary).toBe(first.metadata.summary)
  })

  it('folds only newly added exchanges on a later shift, passing the previous summary', async () => {
    const calls: Array<{ transcript: string; previous?: string }> = []
    const summarize = summarizeMock((transcript, previous) => {
      calls.push({ transcript, previous })
      return Promise.resolve(`updated after ${calls.length}`)
    })
    const strategy = createBoundedContextShiftStrategy({ summarize, stringifySystemText })

    const initialHistory: ChatHistoryItem[] = [
      { type: 'system', text: 'be helpful' },
      { type: 'user', text: 'first question ' + 'x'.repeat(280) },
      { type: 'model', response: ['first answer ' + 'y'.repeat(280)] },
      // Substantial newest exchange: when it later ages out, it must be big
      // enough (>= the digest threshold) to earn a summarizer round-trip.
      { type: 'user', text: 'newest ' + 'n'.repeat(150) },
      { type: 'model', response: ['answer ' + 'a'.repeat(150)] }
    ]
    const first = await strategy({
      chatHistory: initialHistory,
      maxTokensCount: 1_200,
      tokenizer,
      lastShiftMetadata: null
    })

    // The conversation continued: the old newest exchange aged into "older",
    // and a new exchange arrived.
    const laterHistory: ChatHistoryItem[] = [
      ...initialHistory,
      { type: 'user', text: 'second question ' + 'z'.repeat(280) },
      { type: 'model', response: ['second answer'] }
    ]
    const second = await strategy({
      chatHistory: laterHistory,
      maxTokensCount: 1_200,
      tokenizer,
      lastShiftMetadata: first.metadata
    })

    const secondCalls = calls.slice(1)
    expect(secondCalls.length).toBeGreaterThan(0)
    // Previous rolling summary was threaded through...
    expect(secondCalls[0].previous).toBe(first.metadata.summary)
    // ...and the already-covered first exchange was NOT re-rendered into any
    // later transcript.
    for (const call of secondCalls) {
      expect(call.transcript).not.toContain('first question')
    }
    expect(second.metadata.coveredItemCount).toBe(4)
  })

  it("ignores foreign metadata from node-llama-cpp's default strategy", async () => {
    const summarize = summarizeMock(() => Promise.resolve('fresh summary'))
    const strategy = createBoundedContextShiftStrategy({ summarize, stringifySystemText })
    const chatHistory: ChatHistoryItem[] = [
      { type: 'system', text: 'be helpful' },
      { type: 'user', text: 'x'.repeat(300) },
      { type: 'model', response: ['y'.repeat(300)] },
      { type: 'user', text: 'newest' },
      { type: 'model', response: ['answer'] }
    ]

    const result = await strategy({
      chatHistory,
      maxTokensCount: 800,
      tokenizer,
      // What the default strategy leaves behind after a fallback shift.
      lastShiftMetadata: { removedCharactersNumber: 1234 }
    })
    // Treated as no prior state: the older exchange still gets summarized.
    expect(summarize).toHaveBeenCalled()
    expect(result.metadata.summary).toContain('fresh summary')
  })

  it('trims a single oversized final exchange and folds the trimmed evidence into the summary', async () => {
    const summarize = summarizeMock(() => Promise.resolve('evidence digest'))
    const strategy = createBoundedContextShiftStrategy({ summarize, stringifySystemText })

    const manyCalls = Array.from({ length: 40 }, (_, i) =>
      functionCall('fetch_url', { url: `https://example.com/${i}` }, 'x'.repeat(300))
    )
    const chatHistory: ChatHistoryItem[] = [
      { type: 'system', text: 'be helpful' },
      { type: 'user', text: 'investigate bee stings' },
      { type: 'model', response: manyCalls }
    ]

    // 8,000, not a tighter budget — large enough that pass 1 (marker-trim)
    // alone suffices to reach the reserved-headroom target (see
    // `targetBudgetTokens`), so this test isolates pass 1's behavior; pass
    // 4's outright-drop behavior has its own coverage below and in
    // `contextShiftWrapperFit.test.ts`.
    const result = await strategy({
      chatHistory,
      maxTokensCount: 8_000,
      tokenizer,
      lastShiftMetadata: null
    })

    // The trimmed calls' content was folded into the rolling summary...
    expect(summarize).toHaveBeenCalled()
    expect(result.metadata.summary).toContain('evidence digest')
    expect(result.metadata.evidence).toBeDefined()
    expect(result.metadata.evidence!.callCount).toBeGreaterThan(0)

    const response = (result.chatHistory.at(-1) as { response: ChatModelFunctionCall[] }).response
    // Oldest calls got trimmed to the marker, keeping their exact URLs...
    expect(response[0].result).not.toBe('x'.repeat(300))
    expect(response[0].params).toEqual({ url: 'https://example.com/0' })
    // ...and the reconstructed history actually fits the requested budget by
    // FULL cost accounting.
    const total = result.chatHistory.reduce((sum, item) => sum + fullItemCost(item, countTokens), 0)
    expect(total).toBeLessThanOrEqual(8_000)
  })

  it('folds every call actually changed after summary growth forces a deeper trim', async () => {
    const summarize = summarizeMock(() => Promise.resolve('s'.repeat(800)))
    const strategy = createBoundedContextShiftStrategy({ summarize, stringifySystemText })
    const calls = Array.from({ length: 10 }, (_, i) =>
      functionCall('fetch_url', { url: `https://example.com/${i}` }, 'r'.repeat(500))
    )
    const result = await strategy({
      chatHistory: [
        { type: 'system', text: 'sys' },
        { type: 'user', text: 'question' },
        { type: 'model', response: calls }
      ],
      maxTokensCount: 4_000,
      tokenizer,
      lastShiftMetadata: null
    })

    const finalModel = result.chatHistory.at(-1)
    expect(finalModel?.type).toBe('model')
    const survivingOriginalCalls = new Set(
      finalModel?.type === 'model'
        ? finalModel.response.filter(
            (part): part is ChatModelFunctionCall =>
              typeof part !== 'string' && part.type === 'functionCall'
          )
        : []
    )
    let actuallyAffectedEnd = 0
    for (let i = 0; i < calls.length; i++) {
      if (!survivingOriginalCalls.has(calls[i])) actuallyAffectedEnd = i + 1
    }

    expect(actuallyAffectedEnd).toBeGreaterThan(0)
    expect(result.metadata.evidence?.callCount).toBeGreaterThanOrEqual(actuallyAffectedEnd)
  })

  it('does not re-fold already-folded evidence on a repeat shift of the same mega-turn', async () => {
    const summarize = summarizeMock(() => Promise.resolve('evidence digest'))
    const strategy = createBoundedContextShiftStrategy({ summarize, stringifySystemText })

    const manyCalls = Array.from({ length: 40 }, (_, i) =>
      functionCall('fetch_url', { url: `https://example.com/${i}` }, 'x'.repeat(300))
    )
    const chatHistory: ChatHistoryItem[] = [
      { type: 'system', text: 'be helpful' },
      { type: 'user', text: 'investigate bee stings' },
      { type: 'model', response: manyCalls }
    ]

    const first = await strategy({
      chatHistory,
      maxTokensCount: 6_000,
      tokenizer,
      lastShiftMetadata: null
    })
    const callsAfterFirst = summarize.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(2)

    // Identical canonical history (no new calls since): the evidence cursor
    // must prevent re-folding the calls already covered. The second shift's
    // budget is slightly tighter (the summary now occupies system-prompt
    // space), so it may legitimately trim-and-fold ONE OR TWO additional
    // calls — but never re-fold the dozens already covered, which without
    // the cursor would re-run the whole multi-chunk fold every shift.
    const second = await strategy({
      chatHistory,
      maxTokensCount: 6_000,
      tokenizer,
      lastShiftMetadata: first.metadata
    })
    const newCalls = summarize.mock.calls.length - callsAfterFirst
    expect(newCalls).toBeLessThanOrEqual(2)
    // The cursor only ever moves forward.
    expect(second.metadata.evidence!.callCount).toBeGreaterThanOrEqual(
      first.metadata.evidence!.callCount
    )

    // A third shift with the second's metadata has a stable budget — it must
    // add nothing at all.
    const callsAfterSecond = summarize.mock.calls.length
    await strategy({
      chatHistory,
      maxTokensCount: 6_000,
      tokenizer,
      lastShiftMetadata: second.metadata
    })
    expect(summarize.mock.calls.length).toBe(callsAfterSecond)
  })

  it('carries a metadata shape that satisfies BoundedContextShiftMetadata', async () => {
    const summarize = summarizeMock()
    const strategy = createBoundedContextShiftStrategy({ summarize, stringifySystemText })
    const result = await strategy({
      chatHistory: [
        { type: 'system', text: 's' },
        { type: 'user', text: 'q' },
        { type: 'model', response: ['a'] }
      ],
      maxTokensCount: 10_000,
      tokenizer,
      lastShiftMetadata: null
    })
    const metadata: BoundedContextShiftMetadata = result.metadata
    expect(typeof metadata.coveredItemCount).toBe('number')
  })

  it('reserves for the measured tool-schema cost instead of measuring a candidate as fitting when it will not once schemas are added', async () => {
    // Second, deeper live regression (2026-07-19, same day as the one
    // below): fixing pass 5 alone wasn't enough — the strategy measured its
    // candidate as already fitting (no trim needed at all,
    // `trimmedNewestExchange: false` in the onShift log) for a project chat
    // with a full tool surface, and node-llama-cpp's real re-verification —
    // WITH actual registered function schemas rendered in, which this
    // module can never see on its own — still rejected it. Without
    // `toolSchemaReserveTokens`, this exact history is small enough to
    // measure as fitting; with it (simulating the measured cost of a real
    // multi-tool catalog), the strategy must correctly recognize it does NOT
    // fit and trim.
    const chatHistory: ChatHistoryItem[] = [
      { type: 'system', text: 's'.repeat(1_500) },
      { type: 'user', text: 'y'.repeat(500) },
      { type: 'model', response: [] }
    ]
    const maxTokensCount = 3_686 // 4,096 minus node-llama-cpp's default 10% shift size

    const withoutSchemaAwareness = await createBoundedContextShiftStrategy({
      summarize: summarizeMock(),
      stringifySystemText
    })({ chatHistory, maxTokensCount, tokenizer, lastShiftMetadata: null })
    // Baseline: this history alone measures as fitting without knowing about
    // any registered tools — matches what was actually observed live.
    expect(
      (withoutSchemaAwareness.chatHistory.find((item) => item.type === 'user') as { text: string })
        .text
    ).toBe('y'.repeat(500))

    const withSchemaAwareness = await createBoundedContextShiftStrategy({
      summarize: summarizeMock(),
      stringifySystemText,
      // Simulates the measured cost of Anodex's real project tool catalog
      // (read/write/command/git/plan/memory tools) via `estimateToolSchemaTokens`.
      toolSchemaReserveTokens: 2_000
    })({ chatHistory, maxTokensCount, tokenizer, lastShiftMetadata: null })
    const userText = (
      withSchemaAwareness.chatHistory.find((item) => item.type === 'user') as { text: string }
    ).text
    expect(userText.length).toBeLessThan(500)
    expect(userText).toContain('[message truncated to fit context]')
  })

  it('reproduces the live regression: a first message with nothing foldable still gets a fitting result', async () => {
    // Live reproduction (2026-07-19): a project chat's very first message at
    // a 4,096-token context. `chatHistory` is exactly [system, user, model]
    // with no older exchanges (nothing for level 1) and no function calls
    // yet (nothing for level 2's marker/drop passes) — before pass 5 existed
    // this returned the input byte-identical, node-llama-cpp's own
    // `checkIfHistoryFitsContext` rejected it, and the turn ended empty.
    const summarize = summarizeMock()
    const strategy = createBoundedContextShiftStrategy({ summarize, stringifySystemText })

    const chatHistory: ChatHistoryItem[] = [
      { type: 'system', text: 's'.repeat(2_000) },
      { type: 'user', text: 'y'.repeat(1_000) },
      { type: 'model', response: [] }
    ]

    const result = await strategy({
      chatHistory,
      maxTokensCount: 3_686, // 4,096 minus node-llama-cpp's default 10% shift size
      tokenizer,
      lastShiftMetadata: null
    })

    expect(summarize).not.toHaveBeenCalled() // nothing old enough to fold
    const total = result.chatHistory.reduce((sum, item) => sum + fullItemCost(item, countTokens), 0)
    expect(total).toBeLessThan(
      chatHistory.reduce((sum, item) => sum + fullItemCost(item, countTokens), 0)
    )
    expect(total).toBeLessThanOrEqual(3_686)
  })
})
