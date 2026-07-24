import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/chat.types'
import { loadAttachmentImage } from '../loadAttachmentImage'
import { MessageAttachments } from '../MessageAttachments'

const anodexMocks = vi.hoisted(() => ({
  getAbsolutePath: vi.fn(),
  readFile: vi.fn()
}))

vi.mock('../../../lib/anodex', () => ({
  anodex: {
    workspace: {
      getAbsolutePath: anodexMocks.getAbsolutePath
    },
    attachments: {
      readFile: anodexMocks.readFile
    }
  }
}))

const IMAGE_ATTACHMENT: ChatAttachment = {
  path: 'C:\\Pictures\\robot.png',
  name: 'robot.png',
  sizeBytes: 1234,
  kind: 'image',
  mimeType: 'image/png'
}

describe('MessageAttachments', () => {
  beforeEach(() => {
    anodexMocks.getAbsolutePath.mockReset()
    anodexMocks.readFile.mockReset()
  })

  it('renders image loading cards and keeps ordinary files as compact chips', () => {
    const html = renderToStaticMarkup(
      <MessageAttachments
        messageId="message-1"
        attachments={[
          IMAGE_ATTACHMENT,
          {
            path: 'notes.txt',
            name: 'notes.txt',
            sizeBytes: 42,
            kind: 'text'
          }
        ]}
      />
    )

    expect(html).toContain('Loading image')
    expect(html).toContain('robot.png')
    expect(html).toContain('notes.txt')
  })

  it('reopens an absolute image attachment directly', async () => {
    anodexMocks.readFile.mockResolvedValue({
      ok: true,
      value: {
        kind: 'image',
        dataUrl: 'data:image/png;base64,cGl4ZWxz',
        mimeType: 'image/png',
        sizeBytes: 6,
        truncated: false
      }
    })

    await expect(loadAttachmentImage(IMAGE_ATTACHMENT)).resolves.toBe(
      'data:image/png;base64,cGl4ZWxz'
    )
    expect(anodexMocks.getAbsolutePath).not.toHaveBeenCalled()
    expect(anodexMocks.readFile).toHaveBeenCalledWith('C:\\Pictures\\robot.png')
  })

  it('resolves workspace-relative image paths before reopening them', async () => {
    anodexMocks.getAbsolutePath.mockResolvedValue({
      ok: true,
      value: 'C:\\Workspace\\art\\robot.png'
    })
    anodexMocks.readFile.mockResolvedValue({
      ok: true,
      value: {
        kind: 'image',
        dataUrl: 'data:image/png;base64,cGl4ZWxz',
        mimeType: 'image/png',
        sizeBytes: 6,
        truncated: false
      }
    })

    await expect(loadAttachmentImage({ ...IMAGE_ATTACHMENT, path: 'art/robot.png' })).resolves.toBe(
      'data:image/png;base64,cGl4ZWxz'
    )
    expect(anodexMocks.readFile).toHaveBeenCalledWith('C:\\Workspace\\art\\robot.png')
  })

  it('returns an unavailable state when the original image cannot be reopened', async () => {
    anodexMocks.readFile.mockResolvedValue({
      ok: false,
      error: { code: 'attachments.read-failed', message: 'Could not read that file.' }
    })

    await expect(loadAttachmentImage(IMAGE_ATTACHMENT)).resolves.toBeNull()
  })
})
