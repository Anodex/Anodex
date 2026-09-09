import { describe, expect, it } from 'vitest'
import type { Conversation } from '@shared/conversation.types'
import type { ChatMessage } from '@shared/chat.types'
import { forRemote, REMOTE_MESSAGE_BYTES } from '../remoteTranscript'

/**
 * What a phone is sent when it opens a conversation.
 *
 * The remote protocol refuses any reply over 4MB, because a WebSocket message is
 * buffered whole by the client and an oversized one is an uncatchable
 * `OutOfMemoryError` rather than a slow load. That guard was doing its job and the
 * result was conversations that would not open at all — the desktop refused, the
 * phone reported "too large to send to a phone", and the chat was unreachable from
 * away. This is the other half: send less, rather than send nothing.
 */
describe('forRemote', () => {
  const message = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    role: 'assistant',
    content: 'hello',
    createdAt: 1,
    ...overrides
  })

  const conversation = (messages: ChatMessage[]): Conversation => ({
    id: 'chat-1',
    projectId: 'p1',
    title: 'A chat',
    messages,
    createdAt: 1,
    updatedAt: 2
  })

  it('sends only the fields the phone reads', () => {
    // A ChatMessage carries tool calls, render blocks, context assemblies,
    // generation stats and attachments. The phone parses four fields and renders
    // none of the rest, and on an agent transcript the rest is most of the bytes.
    const sent = forRemote(
      conversation([
        message('a', {
          toolCalls: [{ id: 't', name: 'read_file', arguments: '{}' }],
          blocks: [{ type: 'text', text: 'x' }],
          stats: { tokens: 40, durationMs: 1000, tokensPerSecond: 12 },
          attachments: [{ id: 'f', name: 'big.png', kind: 'image' }]
          // Through `unknown`: these are stand-ins for the heavy fields, and what
          // is being asserted is what comes *out*, not that the fixture is a
          // faithful ToolCall.
        } as unknown as Partial<ChatMessage>)
      ])
    )

    expect(Object.keys(sent.messages[0]).sort()).toEqual(['content', 'id', 'role'])
  })

  it('keeps a persona, which the phone does render', () => {
    const sent = forRemote(
      conversation([message('a', { persona: { id: 'p', name: 'Vale', tint: 'accent' } })])
    )

    expect(sent.messages[0].persona?.name).toBe('Vale')
  })

  it('cuts one oversized turn rather than dropping it', () => {
    // A model asked for a complete web page answers with one. Dropping that turn
    // would leave a hole in the middle of the conversation with no explanation.
    const huge = 'x'.repeat(REMOTE_MESSAGE_BYTES * 2)
    const sent = forRemote(conversation([message('a', { content: huge })]))

    expect(sent.messages).toHaveLength(1)
    expect(sent.messages[0].content.length).toBeLessThan(huge.length)
    expect(sent.messages[0].content).toContain('Open this conversation on the computer')
    expect(sent.partial).toBe(true)
  })

  it('drops the oldest turns when the whole thing will not fit', () => {
    const each = 'y'.repeat(400)
    const sent = forRemote(
      conversation([message('old', { content: each }), message('new', { content: each })]),
      600
    )

    expect(sent.messages.map((m) => m.id)).toEqual(['new'])
    expect(sent.partial).toBe(true)
  })

  it('keeps the newest turn even when it alone is over budget', () => {
    // A conversation that opens on its last reply is worth more than one that
    // refuses to open.
    const sent = forRemote(conversation([message('a', { content: 'z'.repeat(5000) })]), 100)

    expect(sent.messages.map((m) => m.id)).toEqual(['a'])
  })

  it('says nothing is missing when nothing is', () => {
    const sent = forRemote(conversation([message('a'), message('b')]))

    expect(sent.messages.map((m) => m.id)).toEqual(['a', 'b'])
    expect(sent.partial).toBe(false)
  })

  it('keeps the turns in the order they were said', () => {
    const sent = forRemote(conversation([message('a'), message('b'), message('c')]))

    expect(sent.messages.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('carries the conversation this is, so the phone files it correctly', () => {
    const sent = forRemote(conversation([message('a')]))

    expect(sent.id).toBe('chat-1')
    expect(sent.projectId).toBe('p1')
    expect(sent.title).toBe('A chat')
    expect(sent.createdAt).toBe(1)
  })

  it('never cuts in the middle of a character', () => {
    // Characters are not bytes: one emoji is four. Slicing to a byte budget by
    // character count overshoots, and a half-written character is invalid UTF-8.
    const emoji = '🛰'.repeat(REMOTE_MESSAGE_BYTES)
    const sent = forRemote(conversation([message('a', { content: emoji })]))

    const content = sent.messages[0].content
    expect(content).not.toContain('�')
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(REMOTE_MESSAGE_BYTES * 2)
  })

  it('survives a turn with no content at all', () => {
    // An image sent with no caption is still a turn.
    const sent = forRemote(conversation([message('a', { content: '' })]))

    expect(sent.messages[0].content).toBe('')
  })
})
