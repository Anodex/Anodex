import { describe, expect, it } from 'vitest'
import type { Conversation } from '@shared/conversation.types'
import type { ChatMessage } from '@shared/chat.types'
import { conversationToMarkdown, exportFileStem } from '../conversationExport'

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm1', role: 'user', content: 'Hello', createdAt: 1, ...overrides }
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    projectId: null,
    title: 'Deploy notes',
    messages: [],
    createdAt: 1,
    updatedAt: Date.UTC(2026, 6, 30),
    ...overrides
  }
}

describe('exportFileStem', () => {
  it('leads with the date so exports sort chronologically', () => {
    expect(exportFileStem(conversation())).toBe('2026-07-30-Deploy-notes')
  })

  it('strips characters no filesystem will take', () => {
    const stem = exportFileStem(conversation({ title: 'a/b\\c:d*e?f"g<h>i|j' }))
    expect(stem).toBe('2026-07-30-abcdefghij')
  })

  it('falls back to the date alone when the title has nothing usable', () => {
    expect(exportFileStem(conversation({ title: '   ' }))).toBe('2026-07-30')
    expect(exportFileStem(conversation({ title: '///' }))).toBe('2026-07-30')
  })

  it('bounds a very long title instead of producing an unopenable path', () => {
    const stem = exportFileStem(conversation({ title: 'x'.repeat(200) }))
    expect(stem.length).toBeLessThanOrEqual('2026-07-30-'.length + 60)
  })
})

describe('conversationToMarkdown', () => {
  it('labels who said what in plain language', () => {
    const md = conversationToMarkdown(
      conversation({
        messages: [
          message({ id: 'm1', role: 'user', content: 'How do I deploy?' }),
          message({ id: 'm2', role: 'assistant', content: 'Run the deploy script.' })
        ]
      })
    )
    expect(md).toContain('## You')
    expect(md).toContain('How do I deploy?')
    expect(md).toContain('## Anodex')
    expect(md).toContain('Run the deploy script.')
  })

  it('summarises a tool call to one line rather than dumping its payload', () => {
    const md = conversationToMarkdown(
      conversation({
        messages: [
          message({
            id: 'm2',
            role: 'assistant',
            content: 'Reading it now.',
            toolCalls: [
              {
                id: 't1',
                name: 'read_file',
                kind: 'read',
                title: 'Read src/index.ts',
                status: 'success',
                detail: 'src/index.ts\nplus a second line that should not appear'
              }
            ]
          })
        ]
      })
    )
    expect(md).toContain('- `read_file` — src/index.ts')
    expect(md).not.toContain('should not appear')
  })

  it('skips a message with neither text nor tool calls', () => {
    const md = conversationToMarkdown(
      conversation({
        messages: [message({ id: 'm1', content: '   ' }), message({ id: 'm2', content: 'Real' })]
      })
    )
    expect(md.match(/## You/g)).toHaveLength(1)
  })

  it('ends with exactly one newline', () => {
    const md = conversationToMarkdown(conversation({ messages: [message()] }))
    expect(md.endsWith('\n')).toBe(true)
    expect(md.endsWith('\n\n')).toBe(false)
  })

  it('still produces a usable document for an empty conversation', () => {
    const md = conversationToMarkdown(conversation())
    expect(md).toContain('# Deploy notes')
    expect(md).toContain('Exported from Anodex')
  })
})
