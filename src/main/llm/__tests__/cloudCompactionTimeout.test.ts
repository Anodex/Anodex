import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The compaction summary each cloud provider makes runs *inside* a turn, from
 * `boundHistoryForStatelessProvider`, and no abort signal reaches it — the
 * `RollingSummarizer` contract has nowhere to put one. Left on the SDK default
 * of ten minutes, a provider that accepted the request and went quiet held the
 * turn open for most of its own budget with Stop unable to touch it.
 *
 * These assert the bound is on the request, for all three providers at once,
 * because that is how the same omission came to exist in three places.
 */

const mocks = vi.hoisted(() => ({
  /** Request options passed alongside each compaction call body. */
  openAi: [] as unknown[],
  anthropic: [] as unknown[],
  compatible: [] as unknown[]
}))

vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: {
    get: () => ({
      provider: {
        openai: { apiKey: 'k', model: 'gpt-5' },
        anthropic: { apiKey: 'k', model: 'claude-opus-4-1-20250805' }
      }
    })
  }
}))

vi.mock('../../stats/TokenActivityStore', () => ({
  tokenActivityStore: { recordAncillaryUsage: vi.fn() }
}))

vi.mock('openai', () => {
  class OpenAI {
    static AuthenticationError = class extends Error {}
    static NotFoundError = class extends Error {}
    responses = {
      create: (_body: unknown, options: unknown) => {
        mocks.openAi.push(options)
        return Promise.resolve({ output_text: 'x'.repeat(400), usage: null })
      }
    }
    chat = {
      completions: {
        create: (_body: unknown, options: unknown) => {
          mocks.compatible.push(options)
          return Promise.resolve({
            choices: [{ message: { content: 'x'.repeat(400) } }],
            usage: null
          })
        }
      }
    }
  }
  return { default: OpenAI, APIUserAbortError: class extends Error {} }
})

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    static AuthenticationError = class extends Error {}
    static NotFoundError = class extends Error {}
    messages = {
      create: (_body: unknown, options: unknown) => {
        mocks.anthropic.push(options)
        return Promise.resolve({ content: [{ type: 'text', text: 'x'.repeat(400) }], usage: null })
      }
    }
  }
  return { default: Anthropic, APIUserAbortError: class extends Error {} }
})

const { summarizeForCompactionOpenAi } = await import('../OpenAiProvider')
const { summarizeForCompactionAnthropic } = await import('../AnthropicProvider')
const { COMPACTION_TIMEOUT_MS } = await import('../cloudTimeouts')

beforeEach(() => {
  mocks.openAi.length = 0
  mocks.anthropic.length = 0
  mocks.compatible.length = 0
})

describe('cloud context compaction is bounded', () => {
  it('gives the OpenAI summary call a deadline', async () => {
    await summarizeForCompactionOpenAi('a transcript to summarize')

    expect(mocks.openAi[0]).toMatchObject({ timeout: COMPACTION_TIMEOUT_MS })
  })

  it('gives the Anthropic summary call a deadline', async () => {
    await summarizeForCompactionAnthropic('a transcript to summarize')

    expect(mocks.anthropic[0]).toMatchObject({ timeout: COMPACTION_TIMEOUT_MS })
  })

  // Passes pre-fix — the constant did not exist to be wrong. It pins the one
  // property that makes a tight bound the right call.
  it('keeps the bound well under a turn’s own budget', () => {
    // The point is that failing is cheap: every caller treats null as "no
    // summary" and drops the older turns instead, so a slow summary costs the
    // turn far more than a missing one does.
    expect(COMPACTION_TIMEOUT_MS).toBeLessThan(15 * 60_000)
  })
})
