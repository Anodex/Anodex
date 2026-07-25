import type {
  EmailAccount,
  EmailAttachmentSummary,
  EmailFlagAction,
  EmailMailbox,
  EmailMessage,
  EmailProvider,
  EmailThreadSummary
} from '@shared/email.types'
import type { OutgoingMessage } from '../mime'

export interface EmailAttachmentContent extends EmailAttachmentSummary {
  data: Buffer
}

export interface ListThreadsOptions {
  limit: number
  /** Provider-native query string; absent means "everything in `mailbox`". */
  query?: string
  /** Mailbox/label to read; absent means the inbox. */
  mailbox?: string
}

/** Identity confirmed by the provider at link time, used to name the account. */
export interface EmailIdentity {
  address: string
  displayName?: string
}

export interface FlagTarget {
  threadId?: string
  messageId?: string
  action: EmailFlagAction
}

export interface MoveTarget {
  threadId?: string
  messageId?: string
  mailbox: string
}

/**
 * What every email backend must provide. Gmail, Microsoft Graph, and generic
 * IMAP/SMTP each implement this, and `EmailService` is the only caller — so
 * tools, IPC, and the UI never learn which provider an account uses beyond the
 * `provider` tag they display.
 *
 * Adapters are stateless with respect to accounts: every method takes the
 * account it operates on, so one adapter instance serves all accounts of its
 * provider. Anything account-specific (tokens, connections) is looked up per
 * call from `EmailAuthStore`.
 */
export interface EmailProviderAdapter {
  readonly provider: EmailProvider

  /** Confirms credentials work and returns the mailbox's own address. */
  verify(account: EmailAccount): Promise<EmailIdentity>

  listThreads(account: EmailAccount, options: ListThreadsOptions): Promise<EmailThreadSummary[]>

  /** Newest-first messages of one thread, used for summaries and replies. */
  getThreadMessages(account: EmailAccount, threadId: string): Promise<EmailMessage[]>

  readMessage(account: EmailAccount, messageId: string): Promise<EmailMessage>

  getUnreadThreadCount(account: EmailAccount): Promise<number>

  getAttachment(
    account: EmailAccount,
    messageId: string,
    attachmentId: string
  ): Promise<EmailAttachmentContent>

  send(account: EmailAccount, message: OutgoingMessage): Promise<void>

  /**
   * Applies a non-destructive state change. Returns a short human description
   * of what changed, which surfaces in the tool result.
   */
  applyFlag(account: EmailAccount, target: FlagTarget): Promise<string>

  move(account: EmailAccount, target: MoveTarget): Promise<string>

  listMailboxes(account: EmailAccount): Promise<EmailMailbox[]>

  /**
   * Releases anything held open for an account that is being unlinked.
   * Implemented only by adapters that keep live connections — an unlinked
   * account must not leave an authenticated session running.
   */
  disconnect?(accountId: string): void
}
