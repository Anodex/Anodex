import { randomUUID } from 'node:crypto'
import type {
  EmailAccount,
  EmailAttachmentSummary,
  EmailAutoconfig,
  EmailConnectOAuthRequest,
  EmailConnectPasswordRequest,
  EmailConnectionStatus,
  EmailDraft,
  EmailDraftRequest,
  EmailFlagRequest,
  EmailListThreadsRequest,
  EmailMailbox,
  EmailMessage,
  EmailMoveRequest,
  EmailProvider,
  EmailReplyRequest,
  EmailSearchRequest,
  EmailSendRequest,
  EmailThreadSummary
} from '@shared/email.types'
import { emailAccountStore } from './EmailAccountStore'
import { emailAuthStore } from './EmailAuthStore'
import { discoverEmailConfig } from './autoconfig'
import {
  buildReferences,
  extractAddress,
  replyRecipients,
  replySubject,
  type OutgoingMessage
} from './mime'
import { dedupeParticipants, threadPreview } from './threadSummary'
import { authorizeProvider } from './providers/oauthClients'
import { GmailAdapter } from './providers/GmailAdapter'
import { MicrosoftAdapter } from './providers/MicrosoftAdapter'
import { ImapSmtpAdapter } from './providers/ImapSmtpAdapter'
import type { EmailAttachmentContent, EmailProviderAdapter } from './providers/types'
import { createLogger } from '../utils/logger'

const log = createLogger('email')

/**
 * Ceiling on threads returned to a caller.
 *
 * The Email page paginates and can legitimately ask for a few hundred, whereas
 * a tool result goes straight into the model's context — so the tools clamp
 * their own `limit` well below this before calling in (see `emailTools.ts`).
 */
const MAX_EMAIL_RESULTS = 200

const ADAPTERS: Record<EmailProvider, EmailProviderAdapter> = {
  gmail: new GmailAdapter(),
  microsoft: new MicrosoftAdapter(),
  imap: new ImapSmtpAdapter()
}

/** A reply resolved against its parent, ready to confirm and then send. */
export interface PreparedReply {
  accountId: string
  message: OutgoingMessage
  /** Subject of the message being answered, for the confirmation prompt. */
  parentSubject: string
}

/**
 * The single entry point for everything email, across every linked account.
 *
 * Its two jobs are resolving which account a request targets and dispatching to
 * that account's provider adapter. Provider-specific behaviour lives entirely
 * in `providers/`; anything here has to hold for Gmail, Outlook, and a plain
 * IMAP server alike.
 */
class EmailService {
  private drafts = new Map<string, EmailDraft>()

  getStatus(): EmailConnectionStatus {
    const accounts = emailAccountStore.list()
    const primary = emailAccountStore.primary()
    const statuses = accounts.map((account) => ({
      id: account.id,
      provider: account.provider,
      address: account.address,
      displayName: account.displayName,
      connected: emailAuthStore.hasCredentials(account.id),
      isPrimary: account.id === primary?.id,
      reason: emailAuthStore.hasCredentials(account.id)
        ? undefined
        : 'Credentials are missing — reconnect this account.'
    }))

    const primaryStatus = statuses.find((status) => status.isPrimary)
    return {
      enabled: accounts.length > 0,
      connected: Boolean(primaryStatus?.connected),
      accounts: statuses,
      primaryAccountId: primary?.id ?? null,
      address: primary?.address ?? '',
      provider: primary?.provider ?? 'none',
      syncMode: primary?.syncMode ?? 'metadata',
      sendRequiresApproval: true,
      reason: accounts.length === 0 ? 'No email account is linked yet.' : primaryStatus?.reason
    }
  }

  discover(address: string): Promise<EmailAutoconfig> {
    return discoverEmailConfig(address)
  }

  /**
   * Links a Gmail or Outlook account through the browser. The provider's own
   * profile is the source of truth for the address, so a user who typed a
   * different one (or none) still ends up with the mailbox they authorized.
   */
  async connectOAuth(request: EmailConnectOAuthRequest): Promise<EmailConnectionStatus> {
    const tokens = await authorizeProvider(request.provider, {
      clientId: request.oauthClientId,
      clientSecret: request.oauthClientSecret
    })

    // The account has to exist before `verify`, because the adapter reads its
    // token from the credential store keyed by account id.
    const provisional = emailAccountStore.add({
      provider: request.provider,
      address: request.address?.trim() || `pending-${randomUUID()}`,
      displayName: request.address?.trim() || '',
      authKind: 'oauth',
      syncMode: 'metadata',
      ...(request.oauthClientId?.trim() ? { oauthClientId: request.oauthClientId.trim() } : {})
    })
    emailAuthStore.setToken(provisional.id, tokens)
    if (request.oauthClientSecret?.trim()) {
      emailAuthStore.setClientSecret(provisional.id, request.oauthClientSecret.trim())
    }

    try {
      const identity = await ADAPTERS[request.provider].verify(provisional)

      // The user can type one address and then authorize a different one in the
      // browser. When that other mailbox is already linked, adopt the existing
      // account instead of leaving two entries pointing at the same inbox —
      // which would make "the default account" ambiguous and double every
      // cross-account search.
      const duplicate = emailAccountStore
        .list()
        .find(
          (account) =>
            account.id !== provisional.id &&
            account.provider === request.provider &&
            account.address.toLowerCase() === identity.address.toLowerCase()
        )

      if (duplicate) {
        emailAuthStore.setToken(duplicate.id, tokens)
        if (request.oauthClientSecret?.trim()) {
          emailAuthStore.setClientSecret(duplicate.id, request.oauthClientSecret.trim())
        }
        emailAccountStore.remove(provisional.id)
        log.info(`Reconnected existing ${request.provider} account ${identity.address}.`)
      } else {
        emailAccountStore.update(provisional.id, {
          address: identity.address,
          displayName: identity.displayName?.trim() || identity.address
        })
        log.info(`Connected ${request.provider} account ${identity.address}.`)
      }
    } catch (error) {
      // A half-linked account with a bad token is worse than none — it shows as
      // connected and fails every call. Roll it back and surface the failure.
      emailAccountStore.remove(provisional.id)
      throw error
    }

    return this.getStatus()
  }

  /**
   * Links a mailbox over IMAP/SMTP. The credentials are proved against the
   * server before anything is persisted as connected, so a typo surfaces
   * immediately instead of at the first tool call.
   */
  async connectPassword(request: EmailConnectPasswordRequest): Promise<EmailConnectionStatus> {
    const address = request.address.trim()
    if (!address) throw new Error('An email address is required.')
    if (!request.password) throw new Error('A password is required.')

    const account = emailAccountStore.add({
      provider: 'imap',
      address,
      displayName: request.displayName?.trim() || address,
      authKind: 'password',
      syncMode: 'metadata',
      imap: request.imap,
      smtp: request.smtp
    })
    emailAuthStore.setPassword(account.id, request.password)

    try {
      await ADAPTERS.imap.verify(account)
      log.info(`Connected IMAP account ${address}.`)
    } catch (error) {
      emailAccountStore.remove(account.id)
      throw new Error(
        `Could not sign in to ${request.imap.host}: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    return this.getStatus()
  }

  removeAccount(accountId: string): EmailConnectionStatus {
    // Close any live session first — unlinking must not leave an authenticated
    // connection open to a mailbox the user just disconnected.
    for (const adapter of Object.values(ADAPTERS)) adapter.disconnect?.(accountId)
    emailAccountStore.remove(accountId)
    return this.getStatus()
  }

  setPrimaryAccount(accountId: string): EmailConnectionStatus {
    emailAccountStore.setPrimary(accountId)
    return this.getStatus()
  }

  setSyncMode(accountId: string, syncMode: 'metadata' | 'full'): EmailConnectionStatus {
    emailAccountStore.update(accountId, { syncMode })
    return this.getStatus()
  }

  listAccounts(): EmailAccount[] {
    return emailAccountStore.list()
  }

  async listThreads(request: EmailListThreadsRequest = {}): Promise<EmailThreadSummary[]> {
    const { account, adapter } = this.resolve(request.accountId)
    return adapter.listThreads(account, {
      limit: normalizeLimit(request.limit),
      mailbox: request.mailbox
    })
  }

  async search(request: EmailSearchRequest): Promise<EmailThreadSummary[]> {
    const query = request.query.trim()
    if (!query) throw new Error('query is required.')
    const { account, adapter } = this.resolve(request.accountId)
    return adapter.listThreads(account, { limit: normalizeLimit(request.limit), query })
  }

  /**
   * Searches every linked account at once. Used when the model asks about
   * email without naming an account and more than one is linked — otherwise a
   * two-mailbox user silently only ever sees results from one of them.
   */
  async searchAll(request: Omit<EmailSearchRequest, 'accountId'>): Promise<EmailThreadSummary[]> {
    const accounts = emailAccountStore.list()
    if (accounts.length <= 1) return this.search(request)

    const limit = normalizeLimit(request.limit)
    const settled = await Promise.allSettled(
      accounts.map((account) =>
        ADAPTERS[account.provider].listThreads(account, { limit, query: request.query.trim() })
      )
    )

    const threads = settled.flatMap((result, index) => {
      if (result.status === 'fulfilled') return result.value
      log.warn(`Search failed for ${accounts[index].address}:`, result.reason)
      return []
    })
    return threads.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit)
  }

  async getUnreadThreadCount(accountId?: string): Promise<number> {
    const { account, adapter } = this.resolve(accountId)
    return adapter.getUnreadThreadCount(account)
  }

  async readMessage(messageId: string, accountId?: string): Promise<EmailMessage> {
    const id = messageId.trim()
    if (!id) throw new Error('message id is required.')
    const { account, adapter } = this.resolve(accountId)
    return adapter.readMessage(account, id)
  }

  /** Full messages of one thread, oldest first — what the reading pane shows. */
  async getThreadMessages(threadId: string, accountId?: string): Promise<EmailMessage[]> {
    const id = threadId.trim()
    if (!id) throw new Error('thread id is required.')
    const { account, adapter } = this.resolve(accountId)
    const messages = await adapter.getThreadMessages(account, id)
    return [...messages].sort((left, right) => left.date - right.date)
  }

  async summarizeThread(threadId: string, accountId?: string): Promise<string> {
    const id = threadId.trim()
    if (!id) throw new Error('thread id is required.')
    const { account, adapter } = this.resolve(accountId)
    const messages = await adapter.getThreadMessages(account, id)
    if (messages.length === 0) return 'No messages found in this thread.'

    const ordered = [...messages].sort((left, right) => left.date - right.date)
    const participants = dedupeParticipants(
      ordered.flatMap((message) => [message.from, ...message.to])
    )
      .slice(0, 8)
      .join('; ')
    const latest = ordered[ordered.length - 1]

    return [
      `Subject: ${ordered[0].subject}`,
      `Account: ${account.address}`,
      `Messages: ${ordered.length}`,
      participants ? `Participants: ${participants}` : null,
      `Latest: ${new Date(latest.date).toLocaleString()}`,
      '',
      ...ordered.slice(-5).map((message, index) => {
        return `${index + 1}. ${message.from}: ${threadPreview(message)}`
      })
    ]
      .filter(Boolean)
      .join('\n')
  }

  async listAttachments(threadId: string, accountId?: string): Promise<EmailAttachmentSummary[]> {
    const id = threadId.trim()
    if (!id) throw new Error('thread id is required.')
    const { account, adapter } = this.resolve(accountId)
    const messages = await adapter.getThreadMessages(account, id)
    return messages.flatMap((message) => message.attachments)
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
    accountId?: string
  ): Promise<EmailAttachmentContent> {
    const message = messageId.trim()
    const attachment = attachmentId.trim()
    if (!message) throw new Error('message id is required.')
    if (!attachment) throw new Error('attachment id is required.')
    const { account, adapter } = this.resolve(accountId)
    return adapter.getAttachment(account, message, attachment)
  }

  async listMailboxes(accountId?: string): Promise<EmailMailbox[]> {
    const { account, adapter } = this.resolve(accountId)
    return adapter.listMailboxes(account)
  }

  createDraft(request: EmailDraftRequest): EmailDraft {
    validateDraftRequest(request)
    const { account } = this.resolve(request.accountId)
    const draft: EmailDraft = {
      ...request,
      id: randomUUID(),
      provider: account.provider,
      accountId: account.id,
      to: cleanAddresses(request.to),
      cc: cleanAddresses(request.cc),
      bcc: cleanAddresses(request.bcc),
      subject: request.subject.trim(),
      body: request.body.trim(),
      createdAt: Date.now()
    }
    this.drafts.set(draft.id, draft)
    return draft
  }

  /**
   * Looks up a saved draft without sending it — lets the send_email tool
   * preview and confirm the content `send` will actually use when `draftId` is
   * set, instead of confirming against whatever placeholder to/subject/body the
   * model passed alongside it.
   */
  getDraft(draftId: string): EmailDraft | undefined {
    return this.drafts.get(draftId)
  }

  async send(request: EmailSendRequest): Promise<void> {
    const draft = request.draftId ? this.drafts.get(request.draftId) : undefined
    if (request.draftId && !draft) throw new Error(`Email draft not found: ${request.draftId}`)

    const source: EmailDraftRequest = draft ?? request
    validateDraftRequest(source)
    const { account, adapter } = this.resolve(draft?.accountId ?? request.accountId)

    await adapter.send(account, toOutgoingMessage(source))
    if (request.draftId) this.drafts.delete(request.draftId)
  }

  /**
   * Resolves a reply against the message it answers: recipients, subject, and
   * the `In-Reply-To`/`References` chain that makes other mail clients file it
   * as part of the conversation rather than a new one. Returns the prepared
   * message so the caller can show it for approval before
   * {@link sendPrepared} actually sends it.
   */
  async prepareReply(request: EmailReplyRequest): Promise<PreparedReply> {
    const messageId = request.messageId.trim()
    if (!messageId) throw new Error('messageId is required.')
    if (!request.body.trim()) throw new Error('body is required.')

    const { account, adapter } = this.resolve(request.accountId)
    const parent = await adapter.readMessage(account, messageId)

    const recipients = replyRecipients({
      from: parent.from,
      to: parent.to,
      cc: parent.cc,
      selfAddress: account.address,
      replyAll: request.replyAll === true
    })
    if (recipients.to.length === 0) {
      throw new Error('Could not work out who to reply to on that message.')
    }

    return {
      accountId: account.id,
      parentSubject: parent.subject,
      message: {
        to: recipients.to,
        cc: cleanAddresses([...recipients.cc, ...(request.cc ?? [])]),
        bcc: [],
        subject: replySubject(parent.subject),
        body: request.body.trim(),
        attachments: request.attachments ?? [],
        inReplyTo: parent.messageIdHeader,
        references: buildReferences(parent.references, parent.messageIdHeader),
        threadId: parent.threadId
      }
    }
  }

  async sendPrepared(prepared: PreparedReply): Promise<void> {
    const { account, adapter } = this.resolve(prepared.accountId)
    await adapter.send(account, prepared.message)
  }

  async applyFlag(request: EmailFlagRequest): Promise<string> {
    const { account, adapter } = this.resolve(request.accountId)
    const result = await adapter.applyFlag(account, {
      threadId: request.threadId?.trim() || undefined,
      messageId: request.messageId?.trim() || undefined,
      action: request.action
    })
    return `${result} on ${account.address}.`
  }

  async move(request: EmailMoveRequest): Promise<string> {
    const { account, adapter } = this.resolve(request.accountId)
    const result = await adapter.move(account, {
      threadId: request.threadId?.trim() || undefined,
      messageId: request.messageId?.trim() || undefined,
      mailbox: request.mailbox
    })
    return `${result} on ${account.address}.`
  }

  /** Resolves the target account and refuses early if it has no credentials. */
  private resolve(accountId?: string): { account: EmailAccount; adapter: EmailProviderAdapter } {
    const account = emailAccountStore.resolve(accountId)
    if (!emailAuthStore.hasCredentials(account.id)) {
      throw new Error(
        `${account.address} is linked but has no stored credentials. Reconnect it in Settings -> Email.`
      )
    }
    return { account, adapter: ADAPTERS[account.provider] }
  }
}

function toOutgoingMessage(request: EmailDraftRequest): OutgoingMessage {
  return {
    to: cleanAddresses(request.to),
    cc: cleanAddresses(request.cc),
    bcc: cleanAddresses(request.bcc),
    subject: request.subject.trim(),
    body: request.body.trim(),
    attachments: request.attachments ?? [],
    inReplyTo: request.inReplyTo,
    references: request.references,
    threadId: request.threadId
  }
}

function cleanAddresses(addresses: string[] | undefined): string[] {
  const seen = new Set<string>()
  return (addresses ?? [])
    .map((value) => value.trim())
    .filter((value) => {
      if (!value) return false
      const key = extractAddress(value).toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 10
  if (!Number.isFinite(limit)) throw new Error('limit must be a finite number.')
  return Math.max(1, Math.min(Math.floor(limit), MAX_EMAIL_RESULTS))
}

function validateDraftRequest(request: EmailDraftRequest): void {
  if (cleanAddresses(request.to).length === 0) {
    throw new Error('At least one recipient is required.')
  }
  if (!request.subject.trim()) throw new Error('subject is required.')
  if (!request.body.trim()) throw new Error('body is required.')
}

export const emailService = new EmailService()
