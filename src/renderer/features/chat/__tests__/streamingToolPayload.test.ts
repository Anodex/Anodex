import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/chat.types'
import { quarantineStreamingToolPayload, type PendingToolPayloads } from '../streamingToolPayload'

function message(content = ''): ChatMessage {
  return {
    id: 'm_1',
    role: 'assistant',
    content,
    createdAt: 1,
    blocks: content ? [{ type: 'text', text: content }] : undefined
  }
}

describe('quarantineStreamingToolPayload', () => {
  it('passes ordinary streamed text through', () => {
    const pending: PendingToolPayloads = new Map()
    expect(quarantineStreamingToolPayload(message('Hello'), ' world', pending)).toBe(' world')
    expect(pending.size).toBe(0)
  })

  it('passes ordinary JSON examples through', () => {
    const pending: PendingToolPayloads = new Map()
    const token = 'Use this object: {"value": 1, "label": "demo"}'
    expect(quarantineStreamingToolPayload(message(), token, pending)).toBe(token)
    expect(pending.size).toBe(0)
  })

  it('holds raw tool JSON while preserving visible prose before it', () => {
    const pending: PendingToolPayloads = new Map()
    const assistant = message()
    const token = 'I will update that now. {"name": "patch_file", "arguments": {"path": "app.css"}}'

    expect(quarantineStreamingToolPayload(assistant, token, pending)).toBe(
      'I will update that now. '
    )
    expect(pending.get(assistant.id)).toBe(
      '{"name": "patch_file", "arguments": {"path": "app.css"}}'
    )
  })

  it('keeps holding later chunks once a raw payload has started', () => {
    const pending: PendingToolPayloads = new Map([['m_1', '{"name":']])
    const assistant = message('I will update that now. ')

    expect(quarantineStreamingToolPayload(assistant, ' "patch_file"}', pending)).toBe('')
    expect(pending.get(assistant.id)).toBe('{"name": "patch_file"}')
  })

  it('trims an already-visible split fence marker without leaking the next token', () => {
    const pending: PendingToolPayloads = new Map()
    const assistant = message('I will patch this.\n```js')

    expect(quarantineStreamingToolPayload(assistant, 'on\n{"name": "patch_file"}', pending)).toBe(
      ''
    )
    expect(assistant.content).toBe('I will patch this.')
    expect(assistant.blocks).toEqual([{ type: 'text', text: 'I will patch this.' }])
    expect(pending.get(assistant.id)).toBe('```json\n{"name": "patch_file"}')
  })
})
