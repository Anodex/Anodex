import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import { changedFileCount, chatRowStatus } from '../chatRowStatus'

function call(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: 'c',
    name: 'write_file',
    title: 'Write src/app.ts',
    kind: 'write',
    status: 'success',
    ...overrides
  }
}

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return { id: 'm', role: 'assistant', content: '', createdAt: 1, ...overrides }
}

describe('chatRowStatus', () => {
  it('says what a working chat is doing, in the words the transcript uses', () => {
    const live = message({
      streaming: true,
      toolCalls: [call({ status: 'running', title: 'Write checker-game.html' })]
    })
    expect(chatRowStatus({ messages: [message({ role: 'user' }), live] }, true, false)).toEqual({
      text: 'Writing checker-game.html',
      tone: 'live'
    })
  })

  it('says a reply is being written once tools are done and text is streaming', () => {
    const live = message({ streaming: true, content: 'Done! I made' })
    expect(chatRowStatus({ messages: [live] }, true, false)?.text).toBe('Writing response')
  })

  it('says how many files a finished, unopened chat changed', () => {
    const reply = message({
      toolCalls: [
        call({ touchedPaths: ['a.ts'] }),
        call({ touchedPaths: ['a.ts'] }),
        call({ touchedPaths: ['b.ts'] })
      ]
    })
    expect(chatRowStatus({ messages: [reply] }, false, true)).toEqual({
      text: 'Changed 2 files',
      tone: 'changed'
    })
  })

  it('says nothing once the chat has been opened, or when nothing changed', () => {
    const reply = message({ toolCalls: [call({ touchedPaths: ['a.ts'] })] })
    expect(chatRowStatus({ messages: [reply] }, false, false)).toBeNull()
    expect(chatRowStatus({ messages: [message({})] }, false, true)).toBeNull()
  })
})

describe('changedFileCount', () => {
  it('counts only settled, successful writes', () => {
    expect(
      changedFileCount([
        call({ touchedPaths: ['a.ts'] }),
        call({ status: 'error', touchedPaths: ['b.ts'] }),
        call({ status: 'running', touchedPaths: ['c.ts'] }),
        call({ kind: 'read', touchedPaths: ['d.ts'] }),
        call({ touchedPaths: undefined, diff: { path: 'e.ts', before: '', after: 'x' } })
      ])
    ).toBe(2)
  })
})
