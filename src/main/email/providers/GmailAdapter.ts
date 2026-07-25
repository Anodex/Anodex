import type {
  EmailAccount,
  EmailAttachmentSummary,
  EmailMailbox,
  EmailMessage,
  EmailThreadSummary
} from '@shared/email.types'
import type {
  EmailAttachmentContent,
  EmailIdentity,
  EmailProviderAdapter,
  FlagTarget,
  ListThreadsOptions,
  MoveTarget
} from './types'
import type { OutgoingMessage } from '../mime'
import {
  buildMimeMessage,
  decodeBase64Url,
  decodeBase64UrlBuffer,
  encodeBase64Url,
  htmlToPlainText,
  parseReferences,
  splitAddresses
} from '../mime'
import { sanitizeEmailHtml, type InlineImage } from '../htmlBody'
import { accessTokenFor } from './oauthClients'

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** Caps on embedding inline images, since each one costs a separate API call. */
const MAX_INLINE_IMAGES = 12
const MAX_INLINE_TOTAL_BYTES = 6 * 1024 * 1024

interface GmailThreadListResponse {
  threads?: { id: string }[]
}

interface GmailProfileResponse {
  emailAddress?: string
}

interface GmailLabelResponse {
  id?: string
  name?: string
  type?: string
  threadsUnread?: number
}

interface GmailLabelListResponse {
  labels?: GmailLabelResponse[]
}

interface GmailThreadResponse {
  id: string
  messages?: GmailApiMessage[]
}

interface GmailAttachmentResponse {
  data?: string
  size?: number
}

interface GmailApiMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: GmailPayload
}

interface GmailPayload {
  mimeType?: string
  filename?: string
  body?: { data?: string; attachmentId?: string; size?: number }
  headers?: { name: string; value: string }[]
  parts?: GmailPayload[]
}

/** Gmail models mailboxes as labels; these are the ones the flag actions touch. */
const LABEL_UNREAD = 'UNREAD'
const LABEL_STARRED = 'STARRED'
const LABEL_INBOX = 'INBOX'

export class GmailAdapter implements EmailProviderAdapter {
  readonly provider = 'gmail' as const

  async verify(account: EmailAccount): Promise<EmailIdentity> {
    const profile = await this.fetch<GmailProfileResponse>(account, '/profile')
    if (!profile.emailAddress) throw new Error('Gmail did not return an account address.')
    return { address: profile.emailAddress }
  }

  async listThreads(
    account: EmailAccount,
    options: ListThreadsOptions
  ): Promise<EmailThreadSummary[]> {
    const params = new URLSearchParams({ maxResults: String(options.limit) })
    if (options.query) params.set('q', options.query)
    if (options.mailbox) {
      params.append('labelIds', await this.resolveLabelId(account, options.mailbox))
    } else if (!options.query) {
      params.append('labelIds', LABEL_INBOX)
    }

    const result = await this.fetch<GmailThreadListResponse>(
      account,
      `/threads?${params.toString()}`
    )
    const summaries: EmailThreadSummary[] = []
    for (const listed of result.threads ?? []) {
      const thread = await this.fetch<GmailThreadResponse>(
        account,
        `/threads/${encodeURIComponent(listed.id)}?format=metadata`
      )
      if (thread.messages?.length) summaries.push(toThreadSummary(thread, account))
      if (summaries.length >= options.limit) break
    }
    return summaries
  }

  async getThreadMessages(account: EmailAccount, threadId: string): Promise<EmailMessage[]> {
    const thread = await this.fetch<GmailThreadResponse>(
      account,
      `/threads/${encodeURIComponent(threadId)}?format=full`
    )
    return Promise.all(
      (thread.messages ?? []).map((message) =>
        this.withHtmlBody(account, toEmailMessage(message, account), message.payload)
      )
    )
  }

  async readMessage(account: EmailAccount, messageId: string): Promise<EmailMessage> {
    const message = await this.fetch<GmailApiMessage>(
      account,
      `/messages/${encodeURIComponent(messageId)}?format=full`
    )
    return this.withHtmlBody(account, toEmailMessage(message, account), message.payload)
  }

  /**
   * Attaches the sanitized HTML body, pulling down the inline images it
   * references.
   *
   * Gmail hands back attachment *ids*, not bytes, so each embedded image costs
   * a request — unlike IMAP, where mailparser has already decoded everything.
   * Only parts the HTML actually references are fetched, and both the count and
   * total size are capped, so an image-heavy newsletter can't turn one message
   * open into dozens of round-trips.
   */
  private async withHtmlBody(
    account: EmailAccount,
    message: EmailMessage,
    payload: GmailPayload | undefined
  ): Promise<EmailMessage> {
    const html = extractHtml(payload)
    if (!html) return message

    const referenced = collectInlineParts(payload).filter((part) => html.includes(part.contentId))

    const images: InlineImage[] = []
    let budget = MAX_INLINE_TOTAL_BYTES
    for (const part of referenced.slice(0, MAX_INLINE_IMAGES)) {
      if (part.size > budget) continue
      try {
        const response = await this.fetch<GmailAttachmentResponse>(
          account,
          `/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(part.attachmentId)}`
        )
        if (!response.data) continue
        const data = decodeBase64UrlBuffer(response.data)
        budget -= data.length
        images.push({ contentId: part.contentId, mimeType: part.mimeType, data })
      } catch {
        // One image that won't load is not a reason to fail opening the mail.
      }
    }

    return { ...message, bodyHtml: sanitizeEmailHtml(html, images) }
  }

  async getUnreadThreadCount(account: EmailAccount): Promise<number> {
    const label = await this.fetch<GmailLabelResponse>(account, '/labels/INBOX')
    const count = Number(label.threadsUnread ?? 0)
    return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  }

  async getAttachment(
    account: EmailAccount,
    messageId: string,
    attachmentId: string
  ): Promise<EmailAttachmentContent> {
    const message = await this.fetch<GmailApiMessage>(
      account,
      `/messages/${encodeURIComponent(messageId)}?format=full`
    )
    const metadata = extractAttachments(message.payload, message.id).find(
      (item) => item.id === attachmentId
    )
    if (!metadata) throw new Error('Attachment was not found on that message.')

    const response = await this.fetch<GmailAttachmentResponse>(
      account,
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
    )
    if (!response.data) throw new Error('Attachment response did not include data.')
    return {
      ...metadata,
      size: response.size ?? metadata.size,
      data: decodeBase64UrlBuffer(response.data)
    }
  }

  async send(account: EmailAccount, message: OutgoingMessage): Promise<void> {
    const body: { raw: string; threadId?: string } = {
      raw: encodeBase64Url(buildMimeMessage(message))
    }
    // Passing threadId is what makes Gmail file the reply into the existing
    // conversation instead of starting a parallel one that merely shares a
    // subject line.
    if (message.threadId) body.threadId = message.threadId

    await this.fetch(account, '/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  async applyFlag(account: EmailAccount, target: FlagTarget): Promise<string> {
    const modification = FLAG_LABELS[target.action]
    const path = target.threadId
      ? `/threads/${encodeURIComponent(target.threadId)}/modify`
      : `/messages/${encodeURIComponent(requireMessageId(target))}/modify`

    await this.fetch(account, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modification)
    })
    return FLAG_DESCRIPTIONS[target.action]
  }

  async move(account: EmailAccount, target: MoveTarget): Promise<string> {
    const labelId = await this.resolveLabelId(account, target.mailbox)
    const path = target.threadId
      ? `/threads/${encodeURIComponent(target.threadId)}/modify`
      : `/messages/${encodeURIComponent(requireMessageId(target))}/modify`

    await this.fetch(account, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Gmail labels are additive, so applying one is a label add rather than a
      // move; the inbox label is removed so the thread also leaves the inbox,
      // which is what "move to X" means to the user.
      body: JSON.stringify({ addLabelIds: [labelId], removeLabelIds: [LABEL_INBOX] })
    })
    return `Applied label ${target.mailbox} and removed it from the inbox`
  }

  async listMailboxes(account: EmailAccount): Promise<EmailMailbox[]> {
    const response = await this.fetch<GmailLabelListResponse>(account, '/labels')
    return (response.labels ?? [])
      .filter((label) => label.id && label.name)
      .map((label) => ({
        id: label.id as string,
        name: label.name as string,
        system: label.type === 'system'
      }))
  }

  private async resolveLabelId(account: EmailAccount, mailbox: string): Promise<string> {
    const wanted = mailbox.trim()
    if (!wanted) throw new Error('A mailbox name is required.')
    const labels = await this.listMailboxes(account)
    const match =
      labels.find((label) => label.id.toLowerCase() === wanted.toLowerCase()) ??
      labels.find((label) => label.name.toLowerCase() === wanted.toLowerCase())
    if (!match) {
      throw new Error(
        `No Gmail label named "${mailbox}". Available: ${labels.map((l) => l.name).join(', ')}`
      )
    }
    return match.id
  }

  private async fetch<T>(account: EmailAccount, path: string, init: RequestInit = {}): Promise<T> {
    const token = await accessTokenFor(account)
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    const response = await fetch(`${GMAIL_API_BASE}${path}`, { ...init, headers })
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText)
      throw new Error(`Gmail API ${response.status}: ${detail}`)
    }
    return (await response.json()) as T
  }
}

const FLAG_LABELS: Record<
  FlagTarget['action'],
  { addLabelIds: string[]; removeLabelIds: string[] }
> = {
  mark_read: { addLabelIds: [], removeLabelIds: [LABEL_UNREAD] },
  mark_unread: { addLabelIds: [LABEL_UNREAD], removeLabelIds: [] },
  star: { addLabelIds: [LABEL_STARRED], removeLabelIds: [] },
  unstar: { addLabelIds: [], removeLabelIds: [LABEL_STARRED] },
  // Archiving in Gmail is removing INBOX, not moving anything.
  archive: { addLabelIds: [], removeLabelIds: [LABEL_INBOX] },
  unarchive: { addLabelIds: [LABEL_INBOX], removeLabelIds: [] }
}

const FLAG_DESCRIPTIONS: Record<FlagTarget['action'], string> = {
  mark_read: 'Marked as read',
  mark_unread: 'Marked as unread',
  star: 'Starred',
  unstar: 'Removed the star',
  archive: 'Archived (removed from the inbox)',
  unarchive: 'Moved back to the inbox'
}

function requireMessageId(target: { messageId?: string }): string {
  if (!target.messageId?.trim()) throw new Error('A thread id or message id is required.')
  return target.messageId.trim()
}

function toThreadSummary(thread: GmailThreadResponse, account: EmailAccount): EmailThreadSummary {
  const messages = thread.messages ?? []
  const message = [...messages].sort(
    (left, right) => Number(right.internalDate ?? 0) - Number(left.internalDate ?? 0)
  )[0]
  if (!message) throw new Error(`Gmail thread ${thread.id} contained no messages.`)
  return {
    id: thread.id,
    latestMessageId: message.id,
    provider: 'gmail',
    accountId: account.id,
    subject: header(message, 'Subject') || '(no subject)',
    from: header(message, 'From') || 'Unknown sender',
    snippet: message.snippet ?? '',
    updatedAt: Number(message.internalDate ?? Date.now()),
    unread: Boolean(message.labelIds?.includes(LABEL_UNREAD)),
    messageCount: messages.length,
    attachmentCount: messages.reduce(
      (total, item) => total + extractAttachments(item.payload, item.id).length,
      0
    )
  }
}

function toEmailMessage(message: GmailApiMessage, account: EmailAccount): EmailMessage {
  return {
    id: message.id,
    threadId: message.threadId,
    provider: 'gmail',
    accountId: account.id,
    subject: header(message, 'Subject') || '(no subject)',
    from: header(message, 'From') || 'Unknown sender',
    to: splitAddresses(header(message, 'To')),
    cc: splitAddresses(header(message, 'Cc')),
    bcc: splitAddresses(header(message, 'Bcc')),
    date: Number(message.internalDate ?? Date.now()),
    snippet: message.snippet ?? '',
    body: extractBody(message.payload),
    attachments: extractAttachments(message.payload, message.id),
    unread: Boolean(message.labelIds?.includes(LABEL_UNREAD)),
    messageIdHeader: header(message, 'Message-ID') || undefined,
    references: parseReferences(header(message, 'References'))
  }
}

function header(message: GmailApiMessage, name: string): string {
  return (
    message.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())
      ?.value ?? ''
  )
}

function extractBody(payload: GmailPayload | undefined): string {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data)
  }
  if (payload.parts) {
    const plain = payload.parts.map(extractBody).find((part) => part.trim())
    if (plain) return plain
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return htmlToPlainText(decodeBase64Url(payload.body.data))
  }
  return ''
}

/** The message's `text/html` part, preferring the richest alternative available. */
function extractHtml(payload: GmailPayload | undefined): string {
  if (!payload) return ''
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBase64Url(payload.body.data)
  }
  for (const part of payload.parts ?? []) {
    const html = extractHtml(part)
    if (html.trim()) return html
  }
  return ''
}

interface InlinePart {
  contentId: string
  mimeType: string
  attachmentId: string
  size: number
}

/** Image parts carrying a `Content-ID`, which is what a `cid:` URL resolves to. */
function collectInlineParts(payload: GmailPayload | undefined): InlinePart[] {
  if (!payload) return []

  const contentId = payload.headers
    ?.find((item) => item.name.toLowerCase() === 'content-id')
    ?.value?.replace(/[<>]/g, '')
    .trim()

  const current: InlinePart[] =
    contentId && payload.body?.attachmentId && (payload.mimeType ?? '').startsWith('image/')
      ? [
          {
            contentId,
            mimeType: payload.mimeType as string,
            attachmentId: payload.body.attachmentId,
            size: payload.body.size ?? 0
          }
        ]
      : []

  return [...current, ...(payload.parts?.flatMap(collectInlineParts) ?? [])]
}

function extractAttachments(
  payload: GmailPayload | undefined,
  messageId: string
): EmailAttachmentSummary[] {
  if (!payload) return []
  const current =
    payload.filename && payload.body?.attachmentId
      ? [
          {
            id: payload.body.attachmentId,
            messageId,
            filename: payload.filename,
            mimeType: payload.mimeType ?? 'application/octet-stream',
            size: payload.body.size ?? 0
          }
        ]
      : []
  return [
    ...current,
    ...(payload.parts?.flatMap((part) => extractAttachments(part, messageId)) ?? [])
  ]
}
