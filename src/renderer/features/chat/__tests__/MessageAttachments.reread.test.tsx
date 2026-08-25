// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/chat.types'
import { MessageAttachments } from '../MessageAttachments'

const anodexMocks = vi.hoisted(() => ({
  getAbsolutePath: vi.fn(),
  readFile: vi.fn()
}))

vi.mock('../../../lib/anodex', () => ({
  anodex: {
    workspace: { getAbsolutePath: anodexMocks.getAbsolutePath },
    attachments: { readFile: anodexMocks.readFile }
  }
}))

/**
 * A message holding an attachment whose file has since been deleted re-read it
 * from disk on every parent render, because the effect was keyed on the
 * attachment *object* and the parent hands it a fresh one each time. Measured
 * in the log: 81 failed reads of one screenshot removed days earlier, and it
 * was still firing this session.
 */
describe('MessageAttachments does not re-read a file per render', () => {
  beforeEach(() => {
    anodexMocks.getAbsolutePath.mockReset()
    anodexMocks.readFile.mockReset()
    anodexMocks.readFile.mockResolvedValue({ ok: false, error: 'ENOENT' })
  })

  it('reads once across re-renders that pass an equal-but-new attachment', async () => {
    const attachment = (): ChatAttachment => ({
      path: 'C:\\Pictures\\gone.png',
      name: 'gone.png',
      sizeBytes: 1,
      kind: 'image',
      mimeType: 'image/png'
    })

    const view = render(<MessageAttachments messageId="m1" attachments={[attachment()]} />)
    await waitFor(() => expect(anodexMocks.readFile).toHaveBeenCalledTimes(1))

    // Same path, new object identity — exactly what a parent re-render does.
    for (let i = 0; i < 4; i++) {
      view.rerender(<MessageAttachments messageId="m1" attachments={[attachment()]} />)
    }

    await waitFor(() => expect(anodexMocks.readFile).toHaveBeenCalledTimes(1))
    expect(anodexMocks.readFile).toHaveBeenCalledWith('C:\\Pictures\\gone.png')
  })
})
