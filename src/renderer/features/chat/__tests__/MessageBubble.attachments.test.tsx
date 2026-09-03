// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/chat.types'
import { render, screen } from '../../../test-utils/dom'

/**
 * Where an attachment sits in a turn.
 *
 * It used to render *inside* the message bubble, so it inherited the bubble's
 * fill, border and 72% width cap and read as a file record rather than as an
 * image someone shared. It is now a sibling above the bubble, and a message
 * that is nothing but attachments draws no bubble at all -- that case used to
 * leave an empty bordered box under the picture.
 */

vi.mock('../../../lib/anodex', () => ({
  anodex: {
    workspace: { getAbsolutePath: vi.fn() },
    attachments: {
      readFile: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          kind: 'image',
          dataUrl: 'data:image/png;base64,cGl4ZWxz',
          mimeType: 'image/png',
          sizeBytes: 6,
          truncated: false
        }
      })
    }
  }
}))

let settings: unknown = { assistantStyle: { personalities: [], activePersonalityId: null } }

vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) => select({ settings })
}))

vi.mock('../../../stores/chatStore', () => ({
  useChatStore: (select: (state: unknown) => unknown) =>
    select({ editMessage: vi.fn(), regenerate: vi.fn(), messages: [] })
}))

const { MessageBubble } = await import('../MessageBubble')

function userMessage(patch: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content: '',
    createdAt: Date.now(),
    attachments: [
      {
        path: 'C:\\Pictures\\robot.png',
        name: 'robot.png',
        sizeBytes: 1234,
        kind: 'image',
        mimeType: 'image/png'
      }
    ],
    ...patch
  }
}

function renderMessage(message: ChatMessage): HTMLElement {
  const { container } = render(<MessageBubble message={message} conversationStreaming={false} />)
  return container
}

describe('attachments in a message', () => {
  it('renders the attachment outside the bubble, not nested in it', async () => {
    const container = renderMessage(userMessage({ content: 'what is this?' }))

    const image = await screen.findByAltText('robot.png')
    const figure = image.closest('figure')
    expect(figure).toBeTruthy()

    // The bubble is whichever element holds the message text. The picture must
    // not be inside it.
    const text = screen.getByText('what is this?')
    expect(figure?.contains(text)).toBe(false)
    expect(text.contains(figure as Node)).toBe(false)
    expect(container.textContent).toContain('what is this?')
  })

  it('draws no bubble for a message that is only an attachment', async () => {
    const container = renderMessage(userMessage({ content: '' }))

    await screen.findByAltText('robot.png')
    // Every element that would carry the bubble's own chrome is gone; the row
    // holds the figure and the hover footer, nothing else.
    const bubbles = container.querySelectorAll('[class*="bubble"]')
    expect(bubbles.length).toBe(0)
  })

  it('still draws a bubble when an attachment-only message failed', async () => {
    const container = renderMessage(userMessage({ content: '', error: 'Upload failed' }))

    await screen.findByAltText('robot.png')
    expect(container.textContent).toContain('Upload failed')
  })
})

/**
 * The payoff of the personality redesign: a named character answers under its
 * own name. Until this, a personality changed how the assistant talked with no
 * evidence anywhere that anything had happened.
 */
describe('the assistant byline', () => {
  function assistantMessage(): ChatMessage {
    return { id: 'a1', role: 'assistant', content: 'Done.', createdAt: Date.now() }
  }

  it('says Anodex when no character is selected', () => {
    settings = { assistantStyle: { personalities: [], activePersonalityId: null } }
    const container = renderMessage(assistantMessage())

    expect(container.textContent).toContain('Anodex')
  })

  it('answers under the active personality name', () => {
    settings = {
      assistantStyle: {
        personalities: [{ id: 'own-1', name: 'Rook', style: 'skeptical' }],
        activePersonalityId: 'own-1'
      }
    }
    const container = renderMessage(assistantMessage())

    expect(container.textContent).toContain('Rook')
    // Still Anodex underneath: a persona is never mistaken for another product.
    expect(screen.getByTitle('Rook — Anodex')).toBeTruthy()
  })
})
