import { describe, expect, it } from 'vitest'
import type { Conversation } from '../conversation.types'
import {
  messageToHistoryTurn,
  sanitizeAssistantContent,
  sanitizeConversationTranscript,
  sanitizeMessageTranscript
} from '../chatSanitizer'

describe('sanitizeAssistantContent', () => {
  it('removes known raw tool payloads from assistant text', () => {
    expect(
      sanitizeAssistantContent(
        'I will patch it now. {"name": "patch_file", "arguments": {"path": "app.css"}}'
      )
    ).toBe('I will patch it now.')
  })

  it('leaves ordinary JSON text alone', () => {
    const text = 'Use this data: {"value": 1, "label": "demo"}'
    expect(sanitizeAssistantContent(text)).toBe(text)
  })
})

describe('messageToHistoryTurn', () => {
  it('sanitizes assistant content before model replay', () => {
    expect(
      messageToHistoryTurn({
        id: 'm1',
        role: 'assistant',
        content:
          'Let me inspect.\n```json\n{"name": "read_file", "arguments": {"path": "app.ts"}}\n```',
        createdAt: 1
      })
    ).toEqual({
      id: 'm1',
      role: 'assistant',
      content: 'Let me inspect.',
      toolCalls: undefined
    })
  })

  it('does not alter user content', () => {
    const content = 'Why did the assistant print {"name": "read_file"}?'
    expect(
      messageToHistoryTurn({
        id: 'm1',
        role: 'user',
        content,
        createdAt: 1
      })
    ).toEqual({ id: 'm1', role: 'user', content, toolCalls: undefined })
  })

  it('strips ephemeral image previews before model-history replay', () => {
    const turn = messageToHistoryTurn({
      id: 'm1',
      role: 'assistant',
      content: 'I inspected the screenshot.',
      createdAt: 1,
      toolCalls: [
        {
          id: 't1',
          name: 'inspect_visual',
          kind: 'read',
          title: 'Inspect page.html',
          status: 'success',
          preview: {
            kind: 'image',
            title: 'Rendered page.html',
            path: 'page.html',
            dataUrl: 'data:image/png;base64,cGl4ZWxz',
            mimeType: 'image/png'
          }
        }
      ]
    })

    expect(turn.toolCalls?.[0].preview).toBeUndefined()
  })
})

describe('sanitizeMessageTranscript', () => {
  it('cleans assistant text blocks and preserves tool blocks', () => {
    const result = sanitizeMessageTranscript({
      id: 'm1',
      role: 'assistant',
      content: 'Done. {"name": "patch_file", "arguments": {"path": "app.css"}}',
      createdAt: 1,
      blocks: [
        {
          type: 'text',
          text: 'Done. {"name": "patch_file", "arguments": {"path": "app.css"}}'
        },
        {
          type: 'tool',
          call: {
            id: 't1',
            name: 'patch_file',
            kind: 'write',
            title: 'Patch app.css',
            status: 'success'
          }
        }
      ]
    })

    expect(result.changed).toBe(true)
    expect(result.message.content).toBe('Done.')
    expect(result.message.blocks).toEqual([
      { type: 'text', text: 'Done.' },
      {
        type: 'tool',
        call: {
          id: 't1',
          name: 'patch_file',
          kind: 'write',
          title: 'Patch app.css',
          status: 'success'
        }
      }
    ])
  })

  it('removes image preview bytes from both persisted tool-call projections', () => {
    const preview = {
      kind: 'image' as const,
      title: 'Rendered page.html',
      path: 'page.html',
      dataUrl: 'data:image/png;base64,cGl4ZWxz',
      mimeType: 'image/png'
    }
    const call = {
      id: 't1',
      name: 'inspect_visual',
      kind: 'read' as const,
      title: 'Inspect page.html',
      status: 'success' as const,
      preview
    }
    const result = sanitizeMessageTranscript({
      id: 'm1',
      role: 'assistant',
      content: 'Looks good.',
      createdAt: 1,
      toolCalls: [call],
      blocks: [{ type: 'tool', call }]
    })

    expect(result.changed).toBe(true)
    expect(result.message.toolCalls?.[0].preview).toBeUndefined()
    expect(result.message.blocks?.[0]).toMatchObject({
      type: 'tool',
      call: { preview: undefined }
    })
    expect(call.preview).toBe(preview)
  })
})

describe('sanitizeConversationTranscript', () => {
  it('returns an unchanged conversation by reference when nothing needs cleanup', () => {
    const conversation: Conversation = {
      id: 'c1',
      projectId: null,
      title: 'Clean',
      messages: [{ id: 'm1', role: 'assistant', content: 'All good.', createdAt: 1 }],
      createdAt: 1,
      updatedAt: 1
    }

    expect(sanitizeConversationTranscript(conversation)).toEqual({
      conversation,
      changed: false
    })
  })
})
