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
import { buildReferences, htmlToPlainText } from '../mime'
import { sanitizeEmailHtml, type InlineImage } from '../htmlBody'
import { accessTokenFor } from './oauthClients'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/me'

interface GraphList<T> {
  value?: T[]
}

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string }
}

interface GraphMessage {
  id: string
  conversationId?: string
  internetMessageId?: string
  subject?: string
  bodyPreview?: string
  receivedDateTime?: string
  isRead?: boolean
  flag?: { flagStatus?: string }
  hasAttachments?: boolean
  from?: GraphRecipient
  sender?: GraphRecipient
  replyTo?: GraphRecipient[]
  toRecipients?: GraphRecipient[]
  ccRecipients?: GraphRecipient[]
  bccRecipients?: GraphRecipient[]
  body?: { contentType?: string; content?: string }
  internetMessageHeaders?: { name: string; value: string }[]
}

interface GraphAttachment {
  id: string
  name?: string
  contentType?: string
  size?: number
  contentBytes?: string
  isInline?: boolean
  contentId?: string
}

interface GraphFolder {
  id: string
  displayName?: string
  wellKnownName?: string
  unreadItemCount?: number
}

interface GraphUser {
  mail?: string
  userPrincipalName?: string
  displayName?: string
}

/**
 * Outlook.com, Hotmail, Live, and Microsoft 365 mailboxes over Microsoft
 * Graph. Graph has no thread-fetch endpoint, so conversations are assembled by
 * filtering on `conversationId` — the same grouping Outlook itself shows.
 */
export class MicrosoftAdapter implements EmailProviderAdapter {
  readonly provider = 'microsoft' as const

  async verify(account: EmailAccount): Promise<EmailIdentity> {
    const user = await this.fetch<GraphUser>(account, '?$select=mail,userPrincipalName,displayName')
    const address = user.mail?.trim() || user.userPrincipalName?.trim()
    if (!address) throw new Error('Microsoft Graph did not return an account address.')
    return { address, displayName: user.displayName }
  }

  async listThreads(
    account: EmailAccount,
    options: ListThreadsOptions
  ): Promise<EmailThreadSummary[]> {
    const params = new URLSearchParams({
      $top: String(Math.min(options.limit * 4, 100)),
      $select: MESSAGE_SELECT,
      $orderby: 'receivedDateTime desc'
    })
    // Graph rejects $orderby combined with $search, so a query switches to
    // relevance order rather than failing the request outright.
    if (options.query) {
      params.delete('$orderby')
      params.set('$search', `"${options.query.replace(/"/g, '')}"`)
    }

    // A named mailbox scopes the request whether or not there is a query. Graph
    // supports `$search` inside a folder, and the search path used to drop the
    // scope entirely — so a batch preview asking for "matches in this folder"
    // silently listed matches from the whole mailbox, and `applyBatch` then
    // acted on exactly those ids. That is the mis-sweep `previewBatch` exists
    // to prevent. With no mailbox named, a query still searches everywhere and
    // a plain listing still means the inbox, both unchanged.
    const path = options.mailbox
      ? `/mailFolders/${encodeURIComponent(
          await this.resolveFolderId(account, options.mailbox)
        )}/messages?${params.toString()}`
      : options.query
        ? `/messages?${params.toString()}`
        : `/mailFolders/inbox/messages?${params.toString()}`

    const response = await this.fetch<GraphList<GraphMessage>>(account, path)
    return groupIntoThreads(response.value ?? [], account, options.limit)
  }

  async getThreadMessages(account: EmailAccount, threadId: string): Promise<EmailMessage[]> {
    const params = new URLSearchParams({
      $filter: `conversationId eq '${threadId.replace(/'/g, "''")}'`,
      $select: `${MESSAGE_SELECT},body`,
      $orderby: 'receivedDateTime asc',
      $top: '50'
    })
    const response = await this.fetch<GraphList<GraphMessage>>(
      account,
      `/messages?${params.toString()}`
    )
    const messages = response.value ?? []
    return Promise.all(messages.map((message) => this.toEmailMessage(account, message)))
  }

  async readMessage(account: EmailAccount, messageId: string): Promise<EmailMessage> {
    const message = await this.fetch<GraphMessage>(
      account,
      `/messages/${encodeURIComponent(messageId)}?$select=${MESSAGE_SELECT},body,internetMessageHeaders`
    )
    return this.toEmailMessage(account, message)
  }

  async getUnreadThreadCount(account: EmailAccount): Promise<number> {
    const folder = await this.fetch<GraphFolder>(
      account,
      '/mailFolders/inbox?$select=unreadItemCount'
    )
    const count = Number(folder.unreadItemCount ?? 0)
    return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  }

  async getAttachment(
    account: EmailAccount,
    messageId: string,
    attachmentId: string
  ): Promise<EmailAttachmentContent> {
    const attachment = await this.fetch<GraphAttachment>(
      account,
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
    )
    if (!attachment.contentBytes) {
      throw new Error(
        'That attachment has no inline content — it is probably a linked file rather than an attached one.'
      )
    }
    return {
      id: attachment.id,
      messageId,
      filename: attachment.name ?? 'attachment',
      mimeType: attachment.contentType ?? 'application/octet-stream',
      size: attachment.size ?? 0,
      data: Buffer.from(attachment.contentBytes, 'base64')
    }
  }

  async send(account: EmailAccount, message: OutgoingMessage): Promise<void> {
    const payload = {
      message: {
        subject: message.subject,
        body: { contentType: 'Text', content: message.body },
        toRecipients: message.to.map(toGraphRecipient),
        ccRecipients: message.cc.map(toGraphRecipient),
        bccRecipients: message.bcc.map(toGraphRecipient),
        attachments: message.attachments.map((attachment) => ({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: attachment.filename,
          contentType: attachment.mimeType,
          contentBytes: attachment.contentBase64
        })),
        // Graph does not accept In-Reply-To/References as first-class fields;
        // they have to be set as internet message headers for the reply to
        // thread correctly in other mail clients.
        internetMessageHeaders: threadingHeaders(message)
      },
      saveToSentItems: true
    }

    await this.fetch(account, '/sendMail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      expectJson: false
    })
  }

  async saveDraft(account: EmailAccount, message: OutgoingMessage): Promise<string> {
    // POSTing to /messages creates the message in Drafts rather than sending
    // it — Graph has no "save" flag on /sendMail, so this is a different
    // endpoint with the same payload shape minus the send wrapper.
    await this.fetch(account, '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: message.subject,
        body: { contentType: 'Text', content: message.body },
        toRecipients: message.to.map(toGraphRecipient),
        ccRecipients: message.cc.map(toGraphRecipient),
        bccRecipients: message.bcc.map(toGraphRecipient),
        attachments: message.attachments.map((attachment) => ({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: attachment.filename,
          contentType: attachment.mimeType,
          contentBytes: attachment.contentBase64
        })),
        internetMessageHeaders: threadingHeaders(message)
      })
    })
    return `Saved to Drafts on ${account.address}`
  }

  async applyFlag(account: EmailAccount, target: FlagTarget): Promise<string> {
    const messageIds = await this.targetMessageIds(account, target)

    for (const messageId of messageIds) {
      if (target.action === 'archive' || target.action === 'unarchive') {
        await this.moveMessage(
          account,
          messageId,
          target.action === 'archive' ? 'archive' : 'inbox'
        )
        continue
      }
      await this.fetch(account, `/messages/${encodeURIComponent(messageId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(FLAG_PATCHES[target.action])
      })
    }

    return `${FLAG_DESCRIPTIONS[target.action]} (${messageIds.length} message${
      messageIds.length === 1 ? '' : 's'
    })`
  }

  async move(account: EmailAccount, target: MoveTarget): Promise<string> {
    const folderId = await this.resolveFolderId(account, target.mailbox)
    const messageIds = await this.targetMessageIds(account, target)
    for (const messageId of messageIds) {
      await this.moveMessage(account, messageId, folderId)
    }
    return `Moved ${messageIds.length} message${messageIds.length === 1 ? '' : 's'} to ${target.mailbox}`
  }

  async listMailboxes(account: EmailAccount): Promise<EmailMailbox[]> {
    const response = await this.fetch<GraphList<GraphFolder>>(
      account,
      '/mailFolders?$top=100&$select=id,displayName,wellKnownName'
    )
    return (response.value ?? [])
      .filter((folder) => folder.displayName)
      .map((folder) => ({
        id: folder.id,
        name: folder.displayName as string,
        system: Boolean(folder.wellKnownName)
      }))
  }

  private async moveMessage(
    account: EmailAccount,
    messageId: string,
    destinationId: string
  ): Promise<void> {
    await this.fetch(account, `/messages/${encodeURIComponent(messageId)}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationId })
    })
  }

  /** Expands a thread target into its message ids; a message target is itself. */
  private async targetMessageIds(
    account: EmailAccount,
    target: { threadId?: string; messageId?: string }
  ): Promise<string[]> {
    if (target.messageId?.trim()) return [target.messageId.trim()]
    if (!target.threadId?.trim()) throw new Error('A thread id or message id is required.')
    const ids = await this.threadMessageIds(account, target.threadId.trim())
    if (ids.length === 0) throw new Error('That conversation has no messages.')
    return ids
  }

  /**
   * Every message id in a conversation.
   *
   * Separate from `getThreadMessages` because the two want opposite things.
   * That one feeds the reading pane and fetches bodies, so it is capped at 50
   * to keep a thread read cheap — but flag and move targets were reading the
   * same list, which silently capped a bulk action at the first 50 messages.
   * Archiving a long mailing-list thread moved part of it and reported the
   * count it had moved, leaving the rest in the inbox with nothing to say why.
   * Selecting ids alone keeps the higher ceiling cheap.
   */
  private async threadMessageIds(account: EmailAccount, threadId: string): Promise<string[]> {
    const params = new URLSearchParams({
      $filter: `conversationId eq '${threadId.replace(/'/g, "''")}'`,
      $select: 'id',
      $top: '500'
    })
    const response = await this.fetch<GraphList<GraphMessage>>(
      account,
      `/messages?${params.toString()}`
    )
    return (response.value ?? []).map((message) => message.id)
  }

  private async resolveFolderId(account: EmailAccount, mailbox: string): Promise<string> {
    const wanted = mailbox.trim().toLowerCase()
    if (!wanted) throw new Error('A mailbox name is required.')
    // Graph accepts these names directly, so skip the folder listing round-trip.
    if (WELL_KNOWN_FOLDERS.has(wanted)) return wanted

    const folders = await this.listMailboxes(account)
    const match = folders.find((folder) => folder.name.toLowerCase() === wanted)
    if (!match) {
      throw new Error(
        `No Outlook folder named "${mailbox}". Available: ${folders.map((f) => f.name).join(', ')}`
      )
    }
    return match.id
  }

  private async toEmailMessage(
    account: EmailAccount,
    message: GraphMessage
  ): Promise<EmailMessage> {
    const attachments = message.hasAttachments
      ? await this.listAttachmentSummaries(account, message.id)
      : []
    const bodyContent = message.body?.content ?? ''
    const isHtml = message.body?.contentType?.toLowerCase() === 'html'
    const body = isHtml ? htmlToPlainText(bodyContent) : bodyContent
    const bodyHtml =
      isHtml && bodyContent.trim()
        ? sanitizeEmailHtml(
            bodyContent,
            message.hasAttachments ? await this.fetchInlineImages(account, message.id) : []
          )
        : undefined

    return {
      id: message.id,
      threadId: message.conversationId ?? message.id,
      provider: 'microsoft',
      accountId: account.id,
      subject: message.subject?.trim() || '(no subject)',
      from: formatRecipient(message.from ?? message.sender) || 'Unknown sender',
      to: (message.toRecipients ?? []).map(formatRecipient).filter(Boolean),
      cc: (message.ccRecipients ?? []).map(formatRecipient).filter(Boolean),
      bcc: (message.bccRecipients ?? []).map(formatRecipient).filter(Boolean),
      date: message.receivedDateTime ? Date.parse(message.receivedDateTime) : Date.now(),
      snippet: message.bodyPreview ?? '',
      body: body || message.bodyPreview || '',
      ...(bodyHtml ? { bodyHtml } : {}),
      attachments,
      unread: message.isRead === false,
      starred: message.flag?.flagStatus === 'flagged',
      messageIdHeader: message.internetMessageId,
      references: parseHeaderList(message.internetMessageHeaders, 'References')
    }
  }

  /**
   * Inline images for an HTML body. Graph returns the bytes alongside the
   * metadata, so unlike Gmail this is a single request for the whole set —
   * filtered to `isInline` so ordinary file attachments aren't dragged in.
   */
  private async fetchInlineImages(
    account: EmailAccount,
    messageId: string
  ): Promise<InlineImage[]> {
    try {
      const response = await this.fetch<GraphList<GraphAttachment>>(
        account,
        `/messages/${encodeURIComponent(messageId)}/attachments`
      )
      return (response.value ?? [])
        .filter(
          (attachment) =>
            attachment.isInline === true &&
            Boolean(attachment.contentId) &&
            Boolean(attachment.contentBytes) &&
            (attachment.contentType ?? '').startsWith('image/')
        )
        .map((attachment) => ({
          contentId: attachment.contentId as string,
          mimeType: attachment.contentType as string,
          data: Buffer.from(attachment.contentBytes as string, 'base64')
        }))
    } catch {
      // Missing images degrade the body; they should not fail the read.
      return []
    }
  }

  private async listAttachmentSummaries(
    account: EmailAccount,
    messageId: string
  ): Promise<EmailAttachmentSummary[]> {
    const response = await this.fetch<GraphList<GraphAttachment>>(
      account,
      `/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size`
    )
    return (response.value ?? []).map((attachment) => ({
      id: attachment.id,
      messageId,
      filename: attachment.name ?? 'attachment',
      mimeType: attachment.contentType ?? 'application/octet-stream',
      size: attachment.size ?? 0
    }))
  }

  private async fetch<T>(
    account: EmailAccount,
    path: string,
    init: RequestInit & { expectJson?: boolean } = {}
  ): Promise<T> {
    const { expectJson = true, ...requestInit } = init
    const token = await accessTokenFor(account)
    const headers = new Headers(requestInit.headers)
    headers.set('Authorization', `Bearer ${token}`)
    // Required for $search on message collections.
    headers.set('ConsistencyLevel', 'eventual')

    const response = await fetch(`${GRAPH_BASE}${path}`, { ...requestInit, headers })
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText)
      throw new Error(`Microsoft Graph ${response.status}: ${detail}`)
    }
    if (!expectJson || response.status === 204) return undefined as T
    return (await response.json()) as T
  }
}

const MESSAGE_SELECT =
  'id,conversationId,internetMessageId,subject,bodyPreview,receivedDateTime,isRead,hasAttachments,from,sender,replyTo,toRecipients,ccRecipients,bccRecipients,flag'

const WELL_KNOWN_FOLDERS = new Set([
  'inbox',
  'archive',
  'drafts',
  'sentitems',
  'deleteditems',
  'junkemail',
  'outbox'
])

const FLAG_PATCHES: Record<string, Record<string, unknown>> = {
  mark_read: { isRead: true },
  mark_unread: { isRead: false },
  star: { flag: { flagStatus: 'flagged' } },
  unstar: { flag: { flagStatus: 'notFlagged' } }
}

const FLAG_DESCRIPTIONS: Record<FlagTarget['action'], string> = {
  mark_read: 'Marked as read',
  mark_unread: 'Marked as unread',
  star: 'Flagged',
  unstar: 'Cleared the flag',
  archive: 'Moved to Archive',
  unarchive: 'Moved back to the inbox'
}

/**
 * Collapses a flat message list into per-conversation summaries, newest first,
 * standing in for the thread endpoint Graph does not offer.
 */
function groupIntoThreads(
  messages: GraphMessage[],
  account: EmailAccount,
  limit: number
): EmailThreadSummary[] {
  const byConversation = new Map<string, GraphMessage[]>()
  for (const message of messages) {
    const key = message.conversationId ?? message.id
    const existing = byConversation.get(key)
    if (existing) existing.push(message)
    else byConversation.set(key, [message])
  }

  const summaries: EmailThreadSummary[] = []
  for (const [conversationId, group] of byConversation) {
    const sorted = [...group].sort((left, right) => receivedAt(right) - receivedAt(left))
    const latest = sorted[0]
    summaries.push({
      id: conversationId,
      latestMessageId: latest.id,
      provider: 'microsoft',
      accountId: account.id,
      subject: latest.subject?.trim() || '(no subject)',
      from: formatRecipient(latest.from ?? latest.sender) || 'Unknown sender',
      snippet: latest.bodyPreview ?? '',
      updatedAt: receivedAt(latest),
      unread: sorted.some((message) => message.isRead === false),
      starred: sorted.some((message) => message.flag?.flagStatus === 'flagged'),
      messageCount: sorted.length,
      attachmentCount: sorted.filter((message) => message.hasAttachments).length
    })
  }

  return summaries.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit)
}

function receivedAt(message: GraphMessage): number {
  return message.receivedDateTime ? Date.parse(message.receivedDateTime) : 0
}

function formatRecipient(recipient: GraphRecipient | undefined): string {
  const address = recipient?.emailAddress?.address?.trim()
  if (!address) return ''
  const name = recipient?.emailAddress?.name?.trim()
  return name && name !== address ? `${name} <${address}>` : address
}

function toGraphRecipient(address: string): GraphRecipient {
  const match = address.match(/^(.*)<([^>]+)>\s*$/)
  if (match) {
    return {
      emailAddress: { name: match[1].trim().replace(/^"|"$/g, ''), address: match[2].trim() }
    }
  }
  return { emailAddress: { address: address.trim() } }
}

function threadingHeaders(message: OutgoingMessage): { name: string; value: string }[] {
  const headers: { name: string; value: string }[] = []
  if (message.inReplyTo) headers.push({ name: 'In-Reply-To', value: message.inReplyTo })
  const references = buildReferences(message.references, undefined)
  if (references.length > 0) headers.push({ name: 'References', value: references.join(' ') })
  return headers
}

function parseHeaderList(
  headers: { name: string; value: string }[] | undefined,
  name: string
): string[] {
  const value = headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value
  return value?.match(/<[^>]+>/g) ?? []
}
