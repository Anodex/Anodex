// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/chat.types'
import { fireEvent, render, screen } from '../../../test-utils/dom'

/**
 * What a streaming reply costs the window.
 *
 * Measured in a stress test, a long reply held the window at about a quarter of a core.
 * Every streamed token re-rendered every bubble in the conversation. Every
 * quarter-second tick of "Working for Xs" re-rendered every step of the run (91 of
 * them in that reply). Every code block, shut, was highlighted again on every frame.
 * These pin the work that was cut, by counting renders of the text renderer.
 */

const renders = vi.hoisted(() => ({ content: 0 }))

vi.mock('../MessageContent', async (importOriginal) => {
  const { memo } = await import('react')
  const actual = await importOriginal<typeof import('../MessageContent')>()
  const real = actual.MessageContent as unknown as {
    $$typeof?: symbol
    type?: (props: { content: string }) => JSX.Element
  } & ((props: { content: string }) => JSX.Element)
  // Counts the real component's renders, memoized exactly as the real one is.
  const isMemo = real.$$typeof === Symbol.for('react.memo')
  const render = isMemo && real.type ? real.type : real
  function CountedMessageContent(props: { content: string }): JSX.Element {
    renders.content++
    return render(props)
  }
  return { MessageContent: isMemo ? memo(CountedMessageContent) : CountedMessageContent }
})

const highlight = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../../lib/highlight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/highlight')>()
  return {
    ...actual,
    highlightCode: (code: string, language?: string) => {
      highlight.calls++
      return actual.highlightCode(code, language)
    }
  }
})

vi.mock('../../../lib/anodex', () => ({ anodex: {} }))
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({
      settings: {
        appearance: { diffView: 'unified' },
        assistantStyle: { personalities: [], activePersonalityId: null }
      }
    })
}))
vi.mock('../../../stores/chatStore', () => ({
  useChatStore: (select: (state: unknown) => unknown) =>
    select({ editMessage: vi.fn(), regenerateMessage: vi.fn(), messages: [] })
}))

const { MessageBubble } = await import('../MessageBubble')
const { TurnRecap } = await import('../TurnRecap')
const { CodeBlock } = await import('../CodeBlock')

afterEach(() => {
  vi.useRealTimers()
  renders.content = 0
  highlight.calls = 0
})

function reply(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, createdAt: 1_789_000_000_000 }
}

describe('a streamed token', () => {
  it('does not re-render bubbles whose message did not change', () => {
    const settled = reply('a1', 'An earlier answer.')
    const list = (streaming: ChatMessage) => (
      <>
        <MessageBubble
          message={settled}
          conversationStreaming
          // Rebuilt on every list render, the way MessageList builds it.
          regenerateTarget={{ sourceUserMessageId: 'u1', laterTurnCount: 1 }}
          visualComparison={null}
        />
        <MessageBubble message={streaming} conversationStreaming visualComparison={null} />
      </>
    )

    const { rerender } = render(list({ ...reply('a2', 'Wri'), streaming: true }))
    const before = renders.content
    rerender(list({ ...reply('a2', 'Writing'), streaming: true }))

    expect(renders.content - before).toBe(1)
    expect(screen.getByText('Writing')).toBeTruthy()
  })

  it('still re-renders a settled bubble whose regenerate target changed', () => {
    const settled = reply('a1', 'An earlier answer.')
    const { rerender } = render(
      <MessageBubble
        message={settled}
        conversationStreaming={false}
        regenerateTarget={{ sourceUserMessageId: 'u1', laterTurnCount: 0 }}
      />
    )
    rerender(
      <MessageBubble
        message={settled}
        conversationStreaming={false}
        regenerateTarget={{ sourceUserMessageId: 'u1', laterTurnCount: 2 }}
      />
    )
    // Regenerating an older reply asks first; the new count must reach the button.
    fireEvent.click(screen.getByRole('button', { name: /regenerate/i }))
    expect(screen.getByText(/The 2 turns after this reply will be discarded/)).toBeTruthy()
  })
})

describe('the working timer', () => {
  it('ticks without re-rendering the steps under it', () => {
    vi.useFakeTimers()
    const segments = Array.from({ length: 20 }, (_, index) => ({
      type: 'text' as const,
      text: `Step ${index}`
    }))
    render(<TurnRecap segments={segments} streaming startedAt={Date.now()} />)
    const before = renders.content

    act(() => {
      vi.advanceTimersByTime(2_000)
    })

    expect(renders.content).toBe(before)
    expect(screen.getByText(/Working for/)).toBeTruthy()
  })
})

describe('a code block', () => {
  it('is not highlighted while shut, and is when opened', () => {
    const { container, rerender } = render(<CodeBlock code="const a = 1" language="js" />)
    rerender(<CodeBlock code="const a = 12" language="js" />)
    rerender(<CodeBlock code="const a = 123" language="js" />)
    expect(highlight.calls).toBe(0)
    expect(container.textContent).toContain('js')

    fireEvent.click(screen.getByRole('button', { name: /js/ }))

    expect(highlight.calls).toBe(1)
    expect(container.querySelector('code.hljs span')).toBeTruthy()
  })

  it('still names the language of an untagged block while shut', async () => {
    const code = '{\n  "name": "anodex",\n  "private": true\n}'
    const { highlightCode } = await import('../../../lib/highlight')
    const guessed = highlightCode(code).language
    expect(guessed).toBeTruthy()

    const { container } = render(<CodeBlock code={code} />)

    expect(container.querySelector('[class*="language"]')?.textContent).toBe(guessed)
  })
})
