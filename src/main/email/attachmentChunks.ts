import type { EmailAttachmentContent } from './providers/types'

/**
 * Handing an attachment to a phone, a piece at a time.
 *
 * The socket refuses any single response over `MAX_RESPONSE_BYTES` — four
 * megabytes — and base64 inflates by a third, so one-shot delivery would cap
 * attachments at roughly three megabytes. That is under the size of a phone
 * photograph, which makes it the wrong limit for a mail client to have.
 *
 * So the phone asks for ranges. The cost of that, naively, is re-fetching the
 * whole attachment from the provider for every chunk — twelve round trips to
 * Gmail to deliver one PDF. This holds the last one fetched so the chunks after
 * the first are slices of memory.
 *
 * One entry, not a cache with a policy. A reader downloads one attachment at a
 * time, and the moment they start another the first is no longer interesting.
 * Holding more would mean deciding when to let go of somebody's mail, which is a
 * question worth not having.
 */

/** Below the socket's four-megabyte ceiling with room for base64 and the envelope. */
export const ATTACHMENT_CHUNK_BYTES = 2 * 1024 * 1024

interface Held {
  key: string
  content: EmailAttachmentContent
  heldAt: number
}

/**
 * How long a fetched attachment stays held.
 *
 * Long enough to deliver one in chunks over a slow connection, short enough that
 * a mailbox left open does not keep somebody's tax return in memory all day.
 */
const HOLD_MS = 5 * 60 * 1000

let held: Held | null = null

function keyFor(messageId: string, attachmentId: string): string {
  return `${messageId}\u0000${attachmentId}`
}

/** Forget what is held. Called when an account is removed or the app is done with it. */
export function releaseHeldAttachment(): void {
  held = null
}

/**
 * The attachment, fetched once and reused while it is being delivered.
 *
 * `fetch` is only called when this is a different attachment from the one held,
 * or when the hold has expired — so a twelve-chunk download is one provider
 * request rather than twelve.
 */
export async function withAttachment(
  messageId: string,
  attachmentId: string,
  fetch: () => Promise<EmailAttachmentContent>,
  now: number = Date.now()
): Promise<EmailAttachmentContent> {
  const key = keyFor(messageId, attachmentId)

  if (held && held.key === key && now - held.heldAt < HOLD_MS) {
    return held.content
  }

  const content = await fetch()
  held = { key, content, heldAt: now }
  return content
}

export interface AttachmentChunk {
  filename: string
  mimeType: string
  /** The whole attachment's size, so a caller can show progress and know when to stop. */
  size: number
  offset: number
  /** Base64 of the bytes from `offset`, at most `ATTACHMENT_CHUNK_BYTES` of them. */
  base64: string
  /** True when this chunk reaches the end. Saves the caller doing the arithmetic. */
  done: boolean
}

/**
 * One chunk, starting at `offset`.
 *
 * An offset past the end returns an empty, finished chunk rather than throwing:
 * a client that miscounts should stop, not fail, and the size it is given is
 * enough to tell it where the end was.
 */
export function chunkOf(content: EmailAttachmentContent, offset: number): AttachmentChunk {
  const size = content.data.length
  const start = Math.max(0, Math.min(offset, size))
  const end = Math.min(start + ATTACHMENT_CHUNK_BYTES, size)

  return {
    filename: content.filename,
    mimeType: content.mimeType,
    size,
    offset: start,
    base64: content.data.subarray(start, end).toString('base64'),
    done: end >= size
  }
}
