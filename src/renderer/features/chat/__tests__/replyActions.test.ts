import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/chat.types'
import { canContinueReply, webPageToOpen } from '../replyActions'

describe('webPageToOpen', () => {
  it("opens the site's front page when the reply changed it", () => {
    expect(webPageToOpen(['styles.css', 'blog.html', 'index.html'])).toBe('index.html')
    expect(webPageToOpen(['docs/index.html', 'index.html'])).toBe('index.html')
    expect(webPageToOpen(['site\\index.htm', 'site\\a\\index.html'])).toBe('site\\index.htm')
  })

  it('otherwise the first page it changed, and nothing when it changed no page', () => {
    expect(webPageToOpen(['styles.css', 'blog.html', 'about.html'])).toBe('blog.html')
    expect(webPageToOpen(['styles.css', 'blog.js'])).toBeNull()
    expect(webPageToOpen(undefined)).toBeNull()
  })
})

describe('canContinueReply', () => {
  const reply = (patch: Partial<ChatMessage>): ChatMessage => ({
    id: 'a1',
    role: 'assistant',
    content: '',
    createdAt: 0,
    ...patch
  })

  it('offers Continue on the newest reply that failed after doing work', () => {
    // Seen: a website build failed part-way with "Context size has been exceeded".
    const failed = reply({
      content: 'Wrote the stylesheet.',
      error: 'Context size has been exceeded.'
    })
    expect(canContinueReply(failed, true)).toBe(true)

    const toolsOnly = reply({
      error: 'The model provider failed part-way through this reply.',
      toolCalls: [
        { id: 't', name: 'write_file', kind: 'write', title: 'Write a.css', status: 'success' }
      ]
    })
    expect(canContinueReply(toolsOnly, true)).toBe(true)
  })

  it('does not offer it for a reply that did nothing, finished, is still going, or is older', () => {
    expect(canContinueReply(reply({ error: 'Failed.' }), true)).toBe(false)
    expect(canContinueReply(reply({ content: 'Done.' }), true)).toBe(false)
    expect(canContinueReply(reply({ content: 'Wri', error: 'x', streaming: true }), true)).toBe(
      false
    )
    expect(canContinueReply(reply({ content: 'Wrote it.', error: 'x' }), false)).toBe(false)
    expect(canContinueReply({ ...reply({ content: 'hi', error: 'x' }), role: 'user' }, true)).toBe(
      false
    )
  })
})
