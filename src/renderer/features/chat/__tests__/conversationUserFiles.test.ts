import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/chat.types'
import type { ComposerAttachment } from '../../../lib/attachments'
import { conversationUserFiles } from '../conversationUserFiles'

function message(id: string, attachments: { name: string; path: string }[]): ChatMessage {
  return {
    id,
    role: 'user',
    content: '',
    createdAt: 1,
    attachments: attachments.map((attachment) => ({
      ...attachment,
      sizeBytes: 10,
      kind: 'image' as const
    }))
  }
}

function pending(name: string, path: string): ComposerAttachment {
  return { kind: 'image', name, path, dataUrl: '', mimeType: 'image/png', sizeBytes: 10 }
}

describe('conversationUserFiles', () => {
  it('finds a file attached several turns ago', () => {
    // "Send that picture" a turn after attaching it is the ordinary case, and
    // by then the attachment belongs to an older message.
    const files = conversationUserFiles([
      message('m1', [{ name: 'robot.png', path: 'C:\\Users\\Owner\\robot.png' }]),
      message('m2', [])
    ])

    expect(files).toEqual([{ name: 'robot.png', path: 'C:\\Users\\Owner\\robot.png' }])
  })

  it('puts the turn being sent first', () => {
    const files = conversationUserFiles(
      [message('m1', [{ name: 'old.png', path: '/tmp/old.png' }])],
      [pending('new.png', '/tmp/new.png')]
    )

    expect(files[0]).toEqual({ name: 'new.png', path: '/tmp/new.png' })
  })

  it('keeps one entry per path when the same file is attached twice', () => {
    const files = conversationUserFiles(
      [message('m1', [{ name: 'robot.png', path: '/tmp/robot.png' }])],
      [pending('robot.png', '/tmp/robot.png')]
    )

    expect(files).toHaveLength(1)
  })

  it('drops paths that are not absolute', () => {
    // A workspace-relative path recorded by an older build cannot be located
    // from the main process, and offering to send a file that is not there is
    // worse than not offering.
    const files = conversationUserFiles([
      message('m1', [
        { name: 'inside.txt', path: 'src/inside.txt' },
        { name: 'real.png', path: '/tmp/real.png' }
      ])
    ])

    expect(files).toEqual([{ name: 'real.png', path: '/tmp/real.png' }])
  })

  it('caps a long history at the most recent files', () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      message(`m${index}`, [{ name: `f${index}.png`, path: `/tmp/f${index}.png` }])
    )

    const files = conversationUserFiles(messages)

    expect(files).toHaveLength(20)
    // Newest first: the last message's attachment leads.
    expect(files[0].name).toBe('f39.png')
  })

  it('returns nothing for a conversation with no attachments', () => {
    expect(conversationUserFiles([message('m1', [])])).toEqual([])
  })
})
