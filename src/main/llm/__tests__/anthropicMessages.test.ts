import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatHistoryTurn } from '@shared/chat.types'
import type { GenerateParams } from '../../llama/LlamaService'

/**
 * What `AnthropicProvider` puts on the wire. The file had no tests at all.
 *
 * The case that prompted these: `splitHistoryByTokenBudget` keeps as many
 * recent turns as fit and cuts wherever that lands, with no regard for
 * user/assistant pairing — so a compacted conversation can begin with an
 * assistant reply whose own user turn has just been dropped.
 */

const mocks = vi.hoisted(() => ({
  requests: [] as Array<Record<string, unknown>>,
  toolFunctions: {}
}))

vi.mock('@anthropic-ai/sdk', () => {
  class APIUserAbortError extends Error {}
  class Anthropic {
    static AuthenticationError = class extends Error {}
    static NotFoundError = class extends Error {}
    messages = {
      stream: (request: Record<string, unknown>) => {
        mocks.requests.push(request)
        return {
          response: null,
          on: vi.fn(),
          once: vi.fn(),
          finalMessage: () =>
            Promise.resolve({
              content: [],
              stop_reason: 'end_turn',
              usage: { output_tokens: 1, input_tokens: 10 }
            })
        }
      }
    }
    models = { retrieve: vi.fn() }
  }
  return { default: Anthropic, APIUserAbortError }
})

vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: {
    get: () => ({ provider: { anthropic: { apiKey: 'k', model: 'claude-test' } } })
  }
}))

vi.mock('../../tools/registry', () => ({ buildTools: () => mocks.toolFunctions }))

const { anthropicProvider } = await import('../AnthropicProvider')

function turn(role: 'user' | 'assistant', content: string): ChatHistoryTurn {
  return { role, content }
}

function params(history: ChatHistoryTurn[]): GenerateParams {
  return {
    conversationId: 'c1',
    messageId: 'm1',
    history,
    prompt: 'And now?',
    onToken: () => {}
  }
}

function sentRoles(): string[] {
  const messages = mocks.requests[0].messages as Array<{ role: string }>
  return messages.map((m) => m.role)
}

beforeEach(() => {
  mocks.requests.length = 0
  mocks.toolFunctions = {}
})

describe('AnthropicProvider — message history', () => {
  it('drops a leading assistant turn left orphaned by compaction', async () => {
    // What a mid-pair cut leaves behind: the reply survived, the question it
    // answered did not. Replaying it opens the conversation with an answer to
    // something the model cannot see, and the rolling summary already covers
    // what was cut.
    await anthropicProvider.generate(
      params([
        turn('assistant', 'As I was saying, the config lives in src/.'),
        turn('user', 'Thanks — what about tests?'),
        turn('assistant', 'They live in __tests__.')
      ])
    )

    expect(sentRoles()).toEqual(['user', 'assistant', 'user'])
  })

  it('drops a whole leading run of assistant turns, not just the first', async () => {
    await anthropicProvider.generate(
      params([turn('assistant', 'One.'), turn('assistant', 'Two.'), turn('user', 'Right.')])
    )

    expect(sentRoles()).toEqual(['user', 'user'])
  })

  it('keeps assistant turns that follow a real user turn', async () => {
    // Only the leading run is orphaned; everything after the first user turn
    // is ordinary conversation and must survive untouched.
    await anthropicProvider.generate(
      params([turn('user', 'Hello.'), turn('assistant', 'Hi.'), turn('user', 'More.')])
    )

    expect(sentRoles()).toEqual(['user', 'assistant', 'user', 'user'])
  })

  it('still sends the current prompt when every history turn was dropped', async () => {
    await anthropicProvider.generate(params([turn('assistant', 'Orphaned.')]))

    expect(sentRoles()).toEqual(['user'])
    expect(mocks.requests[0].messages).toHaveLength(1)
  })
})
