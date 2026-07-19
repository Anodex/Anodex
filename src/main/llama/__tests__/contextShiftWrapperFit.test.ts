import { describe, expect, it } from 'vitest'
import type { ChatHistoryItem, ChatModelFunctionCall } from 'node-llama-cpp'
import { GeneralChatWrapper, QwenChatWrapper } from 'node-llama-cpp'
import { createBoundedContextShiftStrategy, type ChatWrapperLike } from '../contextShiftStrategy'

/**
 * Integration fit-check through REAL node-llama-cpp chat wrappers.
 *
 * The strategy's own unit tests measure fit with plain-text token costs, but
 * node-llama-cpp's acceptance check (`checkIfHistoryFitsContext` in
 * `LlamaChat.js`) tokenizes the *wrapper-rendered* form — role markers,
 * per-call function syntax, template framing — which costs strictly more.
 * A strategy that fits by plain costs but overshoots when rendered gets
 * silently discarded in favor of the crashing default strategy, on exactly
 * the pathological mega-turn it exists to fix. These tests reproduce the
 * acceptance check with real wrappers (pure-JS classes — no native model or
 * binding is loaded) and the same shared tokenizer convention used across
 * the compaction suites (1 token per character).
 *
 * The wrappers' special-token renderings (BOS/EOT etc.) tokenize here as
 * their literal text via the fake tokenizer — slightly *over*counting
 * relative to a real single-id special token, which keeps the check
 * conservative rather than flattering. Function schema documentation is
 * deliberately absent: node-llama-cpp never passes `availableFunctions` to
 * a context-shift strategy, so schema cost is what the strategy's remaining
 * flat headroom (`TARGET_BUDGET_FRACTION`) covers — asserted here by
 * leaving margin below `maxTokensCount` rather than by rendering schemas.
 */

/** Fake `Tokenizer`: 1 token per character, for both the strategy and the fit-check. */
const fakeTokenizer = Object.assign(
  (text: unknown): number[] => Array.from(String(text)).map((_, i) => i),
  {
    detokenize: (): string => '',
    isSpecialToken: (): boolean => false,
    isEogToken: (): boolean => false
  }
)

const stringifySystemText = (text: unknown): string =>
  typeof text === 'string' ? text : String(text)

function functionCall(name: string, params: unknown, result: string): ChatModelFunctionCall {
  return { type: 'functionCall', name, params, result }
}

/** The real failed Critical Thinking run's shape: [system, user, model] with dozens of packed calls. */
function megaTurnHistory(callCount: number, resultChars: number): ChatHistoryItem[] {
  return [
    { type: 'system', text: 'You are Anodex Critical Thinking: an evidence-first investigator.' },
    {
      type: 'user',
      text: 'why do bee stings hurt so bad and what happens with each type of bee or wasp?'
    },
    {
      type: 'model',
      response: [
        'Investigating across sources.',
        ...Array.from({ length: callCount }, (_, i) =>
          i % 2 === 0
            ? functionCall(
                'web_search',
                { query: `bee sting venom source ${i}` },
                'x'.repeat(resultChars)
              )
            : functionCall(
                'fetch_url',
                { url: `https://example.com/source-${i}` },
                'y'.repeat(resultChars)
              )
        )
      ]
    }
  ]
}

async function renderedCostAfterStrategy(
  wrapper: ChatWrapperLike,
  maxTokensCount: number
): Promise<number> {
  const strategy = createBoundedContextShiftStrategy({
    summarize: () =>
      Promise.resolve(
        'Rolling summary: venom chemistry findings from sources 0-20, exact URLs noted.'
      ),
    stringifySystemText
  })
  const result = await strategy({
    chatHistory: megaTurnHistory(38, 4_000),
    maxTokensCount,
    tokenizer: fakeTokenizer,
    chatWrapper: wrapper,
    lastShiftMetadata: null
  })
  const { contextText } = wrapper.generateContextState({ chatHistory: result.chatHistory })
  return contextText.tokenize(fakeTokenizer).length
}

describe('context-shift strategy output fits when rendered through real chat wrappers', () => {
  const wrappers: Array<[string, () => ChatWrapperLike]> = [
    ['GeneralChatWrapper', () => new GeneralChatWrapper()],
    // The wrapper family the user actually runs locally (Qwen models).
    ['QwenChatWrapper', () => new QwenChatWrapper()]
  ]

  for (const [name, makeWrapper] of wrappers) {
    it(`${name}: fits the real failed run's budget (32K context, 10% shift)`, async () => {
      // 32,768-token context minus node-llama-cpp's default 10% shift size —
      // the exact budget the real crashed run's strategy call would receive.
      const maxTokensCount = 29_491
      const rendered = await renderedCostAfterStrategy(makeWrapper(), maxTokensCount)
      expect(rendered).toBeLessThanOrEqual(maxTokensCount)
    })

    it(`${name}: fits a small-context budget where wrapper overhead dominates`, async () => {
      // 8,192-token context, same 10% shift convention. At this size the
      // per-call wrapper syntax exceeds the flat plain-text headroom — this
      // passes only because of the rendered-cost refinement loop.
      const maxTokensCount = 7_372
      const rendered = await renderedCostAfterStrategy(makeWrapper(), maxTokensCount)
      expect(rendered).toBeLessThanOrEqual(maxTokensCount)
    })

    it(`${name}: fits the live-reproduced regression — first message of a project chat at 4,096 context`, async () => {
      // Exact live reproduction (2026-07-19): a project-attached chat's very
      // first message, 4,096-token context. Nothing in chat history is
      // foldable (no older exchanges) or trimmable via passes 1-4 (no tool
      // calls yet) — the composed system prompt (memory context +
      // workspace/assistant-style text, sized here to roughly match what
      // "Used 3 memories" plus an active project's workspace context costs)
      // and the user's own pasted message are what overflow. Before this
      // fix, the strategy returned its input byte-identical and node-llama-
      // cpp's own re-verification rejected it outright — this is what
      // pass 5 (shrinking the user message text) and the switch to
      // `reservedNonHistoryTokens` (properly-shaped headroom) exist to fix.
      const strategy = createBoundedContextShiftStrategy({
        summarize: () => Promise.resolve(null),
        stringifySystemText
      })
      const chatHistory: ChatHistoryItem[] = [
        {
          type: 'system',
          text:
            'You are Anodex, a helpful local coding assistant working in the "Test AGent" project.\n' +
            "Identity: The user, Gabe, is the creator of Anodex.\nIdentity: The user's name is Gabe.\n" +
            'Preference: Gabe enjoys banter and casual conversation, not just coding tasks.\n' +
            'Workspace: '.padEnd(1_400, 'project structure and file listing context. ')
        },
        {
          type: 'user',
          text:
            "I'm planning a small offsite for my team and want your help thinking it through over " +
            "the next while — I'll ask you a bunch of unrelated things after this too, just keep " +
            'this in mind.\n\nProject codename: Marigold Peak. Budget cap: $14,750. The one hard ' +
            'constraint: my teammate Dev Oyelaran is allergic to shellfish, so no seafood-heavy ' +
            "venues. We're tentatively targeting the week of October 12th. My backup contact for " +
            'the venue is Priya Chandrasekaran, and her direct line is 555-0148 if anyone needs to ' +
            'reach her after hours. One more thing — the internal tracking number for this whole ' +
            'effort is REF-88214, in case it comes up in any paperwork later.'
        },
        { type: 'model', response: [] }
      ]

      const maxTokensCount = 3_686 // 4,096 minus node-llama-cpp's default 10% shift size
      const result = await strategy({
        chatHistory,
        maxTokensCount,
        tokenizer: fakeTokenizer,
        chatWrapper: makeWrapper(),
        lastShiftMetadata: null
      })
      const { contextText } = makeWrapper().generateContextState({
        chatHistory: result.chatHistory
      })
      const rendered = contextText.tokenize(fakeTokenizer).length
      expect(rendered).toBeLessThanOrEqual(maxTokensCount)

      // And the specific facts the user actually needs preserved (this
      // scenario has nowhere to fold them into a summary — level 1 has
      // nothing older, and the user text itself is what's oversized) survive
      // truncation rather than being cut from the front.
      const userItem = result.chatHistory.find((item) => item.type === 'user') as {
        text: string
      }
      expect(userItem.text).toContain('Marigold Peak')
    })
  }
})
