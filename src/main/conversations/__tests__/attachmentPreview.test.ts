import { beforeEach, describe, expect, it, vi } from 'vitest'

const getConversation = vi.fn<(id: string) => unknown>()
const readAttachmentFile = vi.fn<(path: string) => Promise<unknown>>()
const createFromBuffer = vi.fn<(data: Buffer) => unknown>()

vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: (data: Buffer) => createFromBuffer(data) }
}))
vi.mock('../ConversationStore', () => ({
  conversationStore: { get: (id: string) => getConversation(id) }
}))
vi.mock('../../ipc/attachments.handlers', () => ({
  readAttachmentFile: (path: string) => readAttachmentFile(path)
}))
vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: { get: () => ({ workspace: { root: 'C:\\work' } }) }
}))
vi.mock('../../tools/workspace', () => ({
  resolveInWorkspace: (root: string, path: string) => `${root}\\${path}`
}))
vi.mock('../../utils/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }))

const { attachmentPreview, PREVIEW_EDGE } = await import('../attachmentPreview')

/**
 * A phone asks for a picture by where it sits in a conversation, and gets one only if
 * a message there really has it.
 */

function conversationWith(attachments: unknown[]): unknown {
  return {
    id: 'c1',
    messages: [{ id: 'm1', role: 'user', content: 'look', attachments }]
  }
}

function fakeImage(width: number, height: number, jpegBytes = 1000): unknown {
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: (size: { width?: number; height?: number }) =>
      fakeImage(
        size.width ?? Math.round((width * (size.height ?? height)) / height),
        size.height ?? Math.round((height * (size.width ?? width)) / width),
        jpegBytes
      ),
    toJPEG: () => Buffer.alloc(jpegBytes, 1)
  }
  return image
}

beforeEach(() => {
  getConversation.mockReset()
  readAttachmentFile.mockReset()
  createFromBuffer.mockReset()
})

describe('attachmentPreview', () => {
  it('sends a picture a message has, scaled to the phone size', async () => {
    getConversation.mockReturnValue(
      conversationWith([{ path: 'C:\\shots\\a.png', name: 'a.png', sizeBytes: 9, kind: 'image' }])
    )
    readAttachmentFile.mockResolvedValue({
      ok: true,
      value: { kind: 'image', dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png' }
    })
    createFromBuffer.mockReturnValue(fakeImage(1080 * 2, 1920 * 2))

    const preview = await attachmentPreview('c1', 'm1', 0)

    expect(readAttachmentFile).toHaveBeenCalledWith('C:\\shots\\a.png')
    expect(preview?.mimeType).toBe('image/jpeg')
    expect(Math.max(preview!.width, preview!.height)).toBe(PREVIEW_EDGE)
  })

  it('resolves a workspace-relative path against the workspace', async () => {
    getConversation.mockReturnValue(
      conversationWith([{ path: 'shots/a.png', name: 'a.png', sizeBytes: 9, kind: 'image' }])
    )
    readAttachmentFile.mockResolvedValue({ ok: false })

    await attachmentPreview('c1', 'm1', 0)

    expect(readAttachmentFile).toHaveBeenCalledWith('C:\\work\\shots/a.png')
  })

  it('answers null for anything that is not a picture on that message', async () => {
    getConversation.mockReturnValue(
      conversationWith([{ path: 'C:\\notes.txt', name: 'notes.txt', sizeBytes: 9, kind: 'text' }])
    )

    expect(await attachmentPreview('c1', 'm1', 0)).toBeNull()
    expect(await attachmentPreview('c1', 'm1', 1)).toBeNull()
    expect(await attachmentPreview('c1', 'nope', 0)).toBeNull()
    expect(await attachmentPreview('c1', 'm1', -1)).toBeNull()
    expect(await attachmentPreview('c1', 'm1', 0.5)).toBeNull()
    getConversation.mockReturnValue(null)
    expect(await attachmentPreview('missing', 'm1', 0)).toBeNull()
    expect(readAttachmentFile).not.toHaveBeenCalled()
  })

  it('answers null when the file is gone or not a valid image', async () => {
    getConversation.mockReturnValue(
      conversationWith([{ path: 'C:\\gone.png', name: 'gone.png', sizeBytes: 9, kind: 'image' }])
    )
    readAttachmentFile.mockResolvedValue({ ok: false, error: { code: 'attachments.read-failed' } })

    expect(await attachmentPreview('c1', 'm1', 0)).toBeNull()
  })
})
