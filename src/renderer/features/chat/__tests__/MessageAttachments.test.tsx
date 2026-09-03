// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/chat.types'
import { render, screen } from '../../../test-utils/dom'
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

  /** A resolved image, so tests can assert on what a user actually sees. */
  function mockLoadedImage(): void {
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
  }

  it('shows a loading state first, and keeps ordinary files as compact chips', () => {
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

  /**
   * Once loaded, the picture is the whole element -- no card border and no
   * caption bar. The name, the size and the pin control moved onto a hover
   * overlay, so they are still rendered, just not as permanent chrome.
   */
  it('renders a loaded image as the picture itself, with its details on the overlay', async () => {
    mockLoadedImage()
    render(<MessageAttachments messageId="message-1" attachments={[IMAGE_ATTACHMENT]} />)

    const image = await screen.findByAltText('robot.png')
    expect(image.getAttribute('src')).toBe('data:image/png;base64,cGl4ZWxz')
    expect(screen.getByText('Keep for follow-ups')).toBeTruthy()
    expect(screen.getByText('1.2 KB')).toBeTruthy()
  })

  /**
   * The pinned *state* must not hide behind hover: an image silently entering
   * later prompts is exactly what a user needs to see unprompted.
   */
  it('marks an opted-in image as kept, outside the hover overlay', async () => {
    mockLoadedImage()
    render(
      <MessageAttachments
        messageId="message-1"
        attachments={[{ ...IMAGE_ATTACHMENT, visionContextPinned: true }]}
      />
    )

    await screen.findByAltText('robot.png')
    const mark = screen.getByText('Kept')
    expect(mark.closest('figcaption')).toBeNull()
    expect(screen.getByText('Kept for follow-ups')).toBeTruthy()
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

    await expect(loadAttachmentImage(IMAGE_ATTACHMENT.path)).resolves.toBe(
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

    await expect(
      loadAttachmentImage({ ...IMAGE_ATTACHMENT, path: 'art/robot.png' }.path)
    ).resolves.toBe('data:image/png;base64,cGl4ZWxz')
    expect(anodexMocks.readFile).toHaveBeenCalledWith('C:\\Workspace\\art\\robot.png')
  })

  it('returns an unavailable state when the original image cannot be reopened', async () => {
    anodexMocks.readFile.mockResolvedValue({
      ok: false,
      error: { code: 'attachments.read-failed', message: 'Could not read that file.' }
    })

    await expect(loadAttachmentImage(IMAGE_ATTACHMENT.path)).resolves.toBeNull()
  })
})
