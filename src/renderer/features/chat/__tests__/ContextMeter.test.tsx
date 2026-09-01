import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The composer's context meter, and specifically the reply-ceiling zone added
 * to it.
 *
 * That zone exists because a ceiling set too low is invisible until it does
 * damage: a reply cut short mid-tool-call cannot be parsed and loses the whole
 * turn, with nothing in the chat window having said a cap was even on.
 */

interface MeterMocks {
  /** Undefined models "no window known yet", which the meter hides entirely on. */
  contextSize: number | undefined
  maxResponseTokens: number | null
  activeProvider: string
  conversation: {
    id: string
    messages: { id: string; role: 'user' | 'assistant'; content: string; createdAt: number }[]
  }
}

const mocks = vi.hoisted<MeterMocks>(() => ({
  contextSize: 32768,
  maxResponseTokens: null,
  activeProvider: 'local',
  conversation: {
    id: 'c1',
    messages: [
      { id: 'm1', role: 'user', content: 'Build a website.', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'Working on it.', createdAt: 2 }
    ]
  }
}))

function fakeStore(getState: () => unknown) {
  return (selector?: (state: unknown) => unknown) => (selector ? selector(getState()) : getState())
}

vi.mock('../../../stores/chatStore', () => ({
  useChatStore: fakeStore(() => ({
    activeId: 'c1',
    conversations: [mocks.conversation]
  }))
}))

vi.mock('../../../stores/modelStore', () => ({
  useModelStore: fakeStore(() => ({ engine: { contextSize: mocks.contextSize } }))
}))

vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: fakeStore(() => ({
    settings: {
      assistantStyle: { globalStyle: 'You are Anodex.' },
      provider: {
        active: mocks.activeProvider,
        local: { maxResponseTokens: mocks.maxResponseTokens },
        anthropic: { model: 'claude-sonnet-5', maxResponseTokens: 1024 },
        openai: { model: 'gpt-5.1-codex', maxResponseTokens: null },
        deepseek: { model: 'deepseek-v4-flash', maxResponseTokens: null }
      }
    }
  }))
}))

const { ContextMeter } = await import('../ContextMeter')

function render(): string {
  return renderToStaticMarkup(<ContextMeter />)
}

beforeEach(() => {
  mocks.contextSize = 32768
  mocks.maxResponseTokens = null
  mocks.activeProvider = 'local'
  mocks.conversation = {
    id: 'c1',
    messages: [
      { id: 'm1', role: 'user', content: 'Build a website.', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'Working on it.', createdAt: 2 }
    ]
  }
})

describe('ContextMeter reply ceiling', () => {
  it('shows nothing extra when no ceiling is set', () => {
    const html = render()

    expect(html).toContain('32.8k')
    expect(html).not.toContain('max ')
    expect(html).not.toContain('Reply cap')
  })

  it('marks off the fenced room and names the value once a ceiling is on', () => {
    mocks.maxResponseTokens = 2048

    const html = render()

    expect(html).toContain('max 2.0k')
    expect(html).toContain('Reply cap')
    // 2,048 of a 32,768 window — the zone is sized to the share it fences off.
    expect(html).toContain('width:6.25%')
  })

  it('reads the ceiling from the provider actually handling the turn', () => {
    // Local is off, Anthropic has one: switching provider must switch what the
    // meter reports, since the ceiling is per-provider now.
    mocks.activeProvider = 'anthropic'

    const html = render()

    expect(html).toContain('max 1.0k')
  })

  it('never draws the zone wider than the window', () => {
    mocks.maxResponseTokens = 999_999

    const html = render()

    expect(html).toContain('width:100%')
  })

  it('announces the ceiling to screen readers, not just visually', () => {
    mocks.maxResponseTokens = 2048

    const html = render()

    expect(html).toContain('replies capped at 2,048 tokens')
  })

  it('explains a full local window as pending compaction instead of a dead end', () => {
    mocks.conversation = {
      id: 'c1',
      messages: [
        { id: 'm1', role: 'user', content: 'Write a long story.', createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'x'.repeat(160_000), createdAt: 2 }
      ]
    }

    const html = render()

    expect(html).toContain('Full - compacts next')
    expect(html).toContain('Older turns will condense before the next reply.')
  })

  it('renders nothing at all when no context window is known', () => {
    mocks.contextSize = undefined

    expect(render()).toBe('')
  })
})

/**
 * The meter's window used to be resolved by a two-provider branch - Anthropic,
 * then OpenAI, then fall through to the local engine's `contextSize`. Every
 * other cloud provider took that fall-through, so switching chat to DeepSeek
 * left the meter reporting the local model's window: the exact thing the branch
 * was written to prevent, for nine of the eleven providers it did not name.
 */
describe('ContextMeter window by provider', () => {
  it('reports the local engine window for a local chat', () => {
    expect(render()).toContain('32.8k')
  })

  it('does not report the local window for a cloud provider it has no branch for', () => {
    mocks.activeProvider = 'deepseek'

    const html = render()

    expect(html).not.toContain('32.8k')
  })

  it("reports the cloud model's own window", () => {
    mocks.activeProvider = 'deepseek'

    // DeepSeek V4 Flash is a 1,048,576-token window.
    expect(render()).toContain('1048.6k')
  })
})
