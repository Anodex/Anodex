import { describe, expect, it, vi } from 'vitest'
import {
  ATTACHMENT_CHUNK_BYTES,
  chunkOf,
  releaseHeldAttachment,
  withAttachment
} from '../attachmentChunks'
import type { EmailAttachmentContent } from '../providers/types'

/**
 * Delivering an attachment to a phone in pieces.
 *
 * The socket refuses a response over four megabytes and base64 costs a third on
 * top, so one-shot delivery caps attachments below the size of a phone
 * photograph. Ranges fix that; the thing ranges break is the provider round
 * trip, since the naive version re-downloads the whole file for every chunk.
 */
const content = (bytes: number, filename = 'report.pdf'): EmailAttachmentContent => ({
  id: 'a1',
  messageId: 'm1',
  filename,
  mimeType: 'application/pdf',
  size: bytes,
  data: Buffer.alloc(bytes, 7)
})

describe('attachment chunks', () => {
  it('cuts at the chunk size and says it is not finished', () => {
    const chunk = chunkOf(content(ATTACHMENT_CHUNK_BYTES * 2), 0)
    expect(Buffer.from(chunk.base64, 'base64').length).toBe(ATTACHMENT_CHUNK_BYTES)
    expect(chunk.done).toBe(false)
    expect(chunk.size).toBe(ATTACHMENT_CHUNK_BYTES * 2)
  })

  it('marks the last chunk finished', () => {
    const chunk = chunkOf(content(ATTACHMENT_CHUNK_BYTES + 10), ATTACHMENT_CHUNK_BYTES)
    expect(Buffer.from(chunk.base64, 'base64').length).toBe(10)
    expect(chunk.done).toBe(true)
  })

  it('a file smaller than one chunk is finished immediately', () => {
    const chunk = chunkOf(content(12), 0)
    expect(chunk.done).toBe(true)
    expect(Buffer.from(chunk.base64, 'base64').length).toBe(12)
  })

  it('an empty attachment is finished rather than endless', () => {
    // A zero-byte attachment is real — senders produce them — and a client that
    // loops until `done` would never stop if this said otherwise.
    const chunk = chunkOf(content(0), 0)
    expect(chunk.done).toBe(true)
    expect(chunk.base64).toBe('')
  })

  it('an offset past the end stops rather than throws', () => {
    // A client that miscounts should stop, not fail. The size it is handed is
    // enough to tell it where the end was.
    const chunk = chunkOf(content(100), 5000)
    expect(chunk.done).toBe(true)
    expect(chunk.base64).toBe('')
    expect(chunk.offset).toBe(100)
  })

  it('fetches once for a whole download rather than once per chunk', async () => {
    releaseHeldAttachment()
    const fetch = vi.fn(() => Promise.resolve(content(ATTACHMENT_CHUNK_BYTES * 3)))

    for (let i = 0; i < 3; i += 1) {
      await withAttachment('m1', 'a1', fetch)
    }

    // The point of holding it. Without this a twelve-chunk download is twelve
    // round trips to somebody's mail provider for one file.
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fetches again for a different attachment', async () => {
    releaseHeldAttachment()
    const first = vi.fn(() => Promise.resolve(content(10, 'first.pdf')))
    const second = vi.fn(() => Promise.resolve(content(10, 'second.pdf')))

    await withAttachment('m1', 'a1', first)
    const other = await withAttachment('m1', 'a2', second)

    expect(second).toHaveBeenCalledTimes(1)
    expect(other.filename).toBe('second.pdf')
  })

  it('lets go after the hold expires', async () => {
    releaseHeldAttachment()
    const fetch = vi.fn(() => Promise.resolve(content(10)))

    await withAttachment('m1', 'a1', fetch, 0)
    await withAttachment('m1', 'a1', fetch, 10 * 60 * 1000)

    // A mailbox left open should not keep somebody's tax return in memory.
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
