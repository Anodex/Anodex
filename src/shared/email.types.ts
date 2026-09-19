/**
 * Email is multi-account and multi-provider: an account is a
 * `{ provider, address, credentials }` triple, and every read/write request is
 * scoped to one account id. Requests omitting `accountId` fall back to the
 * primary account, which keeps single-account setups (the common case) free of
 * account plumbing at the call site.
 *
 * Credentials never appear in this file's types. Account descriptors live in
 * `AppSettings.email.accounts` (plain JSON on disk); OAuth tokens and IMAP/SMTP
 * passwords live only in `EmailAuthStore`, keyed by account id and encrypted
 * with Electron's `safeStorage`.
 */

export type EmailProvider = 'gmail' | 'microsoft' | 'imap'

/** How Anodex authenticates to a provider. */
export type EmailAuthKind = 'oauth' | 'password'

export type EmailSocketSecurity = 'tls' | 'starttls' | 'plain'

export type EmailSyncMode = 'metadata' | 'full'

/** An IMAP or SMTP server coordinate. Passwords are stored separately. */
export interface EmailEndpoint {
  host: string
  port: number
  security: EmailSocketSecurity
  username: string
}

/**
 * The non-secret half of a linked account, persisted in settings. Anything
 * here is written to `settings.json` in the clear, so it must never hold a
 * password, token, or client secret.
 */
export interface EmailAccount {
  id: string
  provider: EmailProvider
  address: string
  displayName: string
  authKind: EmailAuthKind
  syncMode: EmailSyncMode
  /** Present only when `provider` is 'imap'. */
  imap?: EmailEndpoint
  /** Present only when `provider` is 'imap'. */
  smtp?: EmailEndpoint
  /** Per-account OAuth client override; empty means use the app's built-in client. */
  oauthClientId?: string
  createdAt: number
}

export interface EmailAccountStatus {
  id: string
  provider: EmailProvider
  address: string
  displayName: string
  connected: boolean
  isPrimary: boolean
  /** Why this account is unusable, when `connected` is false. */
  reason?: string
}

export interface EmailConnectionStatus {
  /** True when at least one account is linked. */
  enabled: boolean
  /** True when the primary account has usable credentials. */
  connected: boolean
  accounts: EmailAccountStatus[]
  primaryAccountId: string | null
  /** Primary account's address, or '' when nothing is linked. */
  address: string
  provider: EmailProvider | 'none'
  syncMode: EmailSyncMode
  sendRequiresApproval: true
  reason?: string
}

/** Base for every request that targets one account. */
export interface EmailAccountScoped {
  /** Defaults to the primary account when omitted. */
  accountId?: string
}

export interface EmailThreadSummary {
  id: string
  /** Newest message in the thread; usable with read_email. */
  latestMessageId: string
  provider: EmailProvider
  accountId: string
  subject: string
  from: string
  snippet: string
  updatedAt: number
  unread: boolean
  starred: boolean
  messageCount: number
  attachmentCount: number
}

export interface EmailMessage {
  id: string
  threadId: string
  provider: EmailProvider
  accountId: string
  subject: string
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  date: number
  snippet: string
  body: string
  /**
   * Sanitized HTML body, when the message had one. Inline `cid:` images are
   * already embedded as data URIs; remote image URLs are parked on
   * `data-remote-src` and load only when the reader opts in. Always render this
   * inside a sandboxed, script-free frame — see `main/email/htmlBody.ts`.
   *
   * `body` stays populated as the plain-text equivalent, and remains what the
   * model reads: HTML markup would be mostly wasted context.
   */
  bodyHtml?: string
  attachments: EmailAttachmentSummary[]
  /** Unknown for providers that omit read state from a given fetch. */
  unread?: boolean
  /** Unknown for providers that omit starred/flagged state from a given fetch. */
  starred?: boolean
  /** RFC 5322 Message-ID, needed to thread a reply onto this message. */
  messageIdHeader?: string
  /** Existing References chain, extended when replying. */
  references?: string[]
}

export interface EmailAttachmentSummary {
  id: string
  /** Message that owns this attachment; required by the provider's attachment fetch. */
  messageId: string
  filename: string
  mimeType: string
  size: number
}

export interface EmailSearchRequest extends EmailAccountScoped {
  query: string
  limit?: number
  /**
   * Mailbox/label to search inside; absent searches the account.
   *
   * The same field `EmailListThreadsRequest` has, for the same reason: a reader
   * looking at one folder and typing a word means that folder. Searching
   * everywhere from inside Trash answers a question nobody asked, and answers it
   * with mail that is not in front of them.
   */
  mailbox?: string
}

export interface EmailListThreadsRequest extends EmailAccountScoped {
  limit?: number
  /** Mailbox/label to list; defaults to the inbox. */
  mailbox?: string
}

/** A file attached to an outgoing message, carried inline as base64. */
export interface EmailOutgoingAttachment {
  filename: string
  mimeType: string
  contentBase64: string
}

/**
 * A file the sender has chosen but not yet sent.
 *
 * The same three fields the adapter wants, plus the one the person writing the
 * message needs: how big it is. A composer that cannot say "4.2 MB" next to a
 * file also cannot explain why the provider refused the message, and the
 * refusal arrives minutes later from a server rather than immediately from the
 * window they are looking at.
 */
export interface EmailPickedAttachment extends EmailOutgoingAttachment {
  sizeBytes: number
}

/**
 * As much as one message may carry, before base64.
 *
 * Every provider caps the *encoded* message, and base64 costs a third on top:
 * 18MB of files is about 24MB on the wire, which fits under the 25MB that
 * Gmail, Outlook and most IMAP hosts allow. Checked here rather than left to
 * the server so the answer arrives while the file is being attached, not in a
 * bounce an hour later.
 */
export const MAX_OUTGOING_ATTACHMENT_BYTES = 18 * 1024 * 1024

/**
 * A file size in the units mail providers state their limits in.
 *
 * Here rather than in either process, because both need it and they have to
 * agree: a window saying "4.3 MB" beside a refusal saying "4.2 MB" is a window
 * arguing with itself. It began as two copies with a test pinning that they
 * matched, which is a worse version of one copy.
 *
 * Kilobytes below a tenth of a megabyte. A row reading "report.csv - 0.0 MB"
 * looks like a file that failed to attach.
 */
export function readableAttachmentSize(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 10) return `${Math.round(mb)} MB`
  if (mb >= 0.1) return `${mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export interface EmailDraftRequest extends EmailAccountScoped {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
  attachments?: EmailOutgoingAttachment[]
  /** Message-ID this draft replies to; set by reply_email, not by hand. */
  inReplyTo?: string
  /** Full References chain for the reply. */
  references?: string[]
  /** Provider thread to attach the sent message to. */
  threadId?: string
}

export interface EmailDraft extends EmailDraftRequest {
  id: string
  provider: EmailProvider
  accountId: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  createdAt: number
}

export interface EmailSendRequest extends EmailDraftRequest {
  draftId?: string
}

export interface EmailReplyRequest extends EmailAccountScoped {
  /** Message being replied to; its headers drive the threading. */
  messageId: string
  body: string
  /** Include every original recipient, not just the sender. */
  replyAll?: boolean
  cc?: string[]
  attachments?: EmailOutgoingAttachment[]
}

/** Non-destructive mailbox state changes. Deleting mail is deliberately absent. */
export type EmailFlagAction =
  'mark_read' | 'mark_unread' | 'star' | 'unstar' | 'archive' | 'unarchive'

export interface EmailFlagRequest extends EmailAccountScoped {
  /** One of these is required; threadId applies the action to every message. */
  threadId?: string
  messageId?: string
  action: EmailFlagAction
}

/** One inbox row the list wants a plain-language digest for. */
export interface EmailThreadDigestRequest {
  accountId: string
  threadId: string
  /**
   * The thread's newest message. Doubles as the digest's freshness token: a
   * reply arriving changes it, which retires the old digest without anything
   * having to watch the mailbox for changes.
   */
  latestMessageId: string
}

export interface EmailThreadDigest {
  threadId: string
  /** One sentence describing what the thread wants. */
  digest: string
}

/**
 * Why a digest pass ended where it did.
 *
 * An empty batch used to be the whole answer, and it meant four different
 * things — no model yet, a model that failed, threads nothing can be said
 * about, and simply nothing left to do. The list showed the same alarming
 * banner for all four, including for the two that are not faults at all.
 */
export type EmailDigestOutcome =
  /** Everything asked for is either digested now or waiting for a later batch. */
  | 'ok'
  /** No model loaded, or one still loading — the pass is worth repeating later. */
  | 'engine-unavailable'
  /**
   * The pass tried and could not produce a digest — a model that answered with
   * nothing usable, or a mailbox that would not hand over the thread. The one
   * outcome that is a real fault worth telling the reader about.
   */
  | 'failed'

export interface EmailThreadDigestBatch {
  digests: EmailThreadDigest[]
  outcome: EmailDigestOutcome
  /**
   * Threads this pass gave up on for good — an empty thread, or one whose
   * messages will not load. They are excluded from later passes, so the list
   * must stop counting them as pending or it will ask forever.
   */
  abandonedThreadIds: string[]
}

export interface EmailMailbox {
  id: string
  name: string
  /** True for provider-managed mailboxes (INBOX, Sent) that can't be removed. */
  system: boolean
}

export interface EmailMoveRequest extends EmailAccountScoped {
  threadId?: string
  messageId?: string
  /** Target label (Gmail/Graph) or folder (IMAP), matched by name. */
  mailbox: string
}

/**
 * What `email:discover` returns for a typed address: which provider serves the
 * domain and, when it is a plain IMAP host, the server coordinates to prefill.
 */
export interface EmailAutoconfig {
  address: string
  domain: string
  provider: EmailProvider
  authKind: EmailAuthKind
  /** Human label for the detected service, e.g. 'Google' or 'Fastmail'. */
  serviceName: string
  /** Where the settings came from, for UI wording and debugging. */
  source: 'builtin' | 'ispdb' | 'guess'
  imap?: EmailEndpoint
  smtp?: EmailEndpoint
  /** Provider page where the user generates an app password, when applicable. */
  appPasswordUrl?: string
  /** True when the provider requires an app password rather than the login password. */
  requiresAppPassword?: boolean
  /**
   * A password-based route for a provider that normally uses OAuth. Present
   * only when `authKind` is 'oauth' and the provider still supports IMAP with
   * an app password.
   *
   * This exists because OAuth is the better experience but not always the
   * reachable one: Gmail's scopes are restricted, so a user without a verified
   * OAuth client has to register their own in Google Cloud, which drags in a
   * project, a consent screen, and a test-user list. Offering IMAP as a
   * deliberate second choice means that path is never a dead end.
   */
  passwordFallback?: {
    serviceName: string
    imap: EmailEndpoint
    smtp: EmailEndpoint
    appPasswordUrl?: string
    requiresAppPassword: boolean
    /** One-line explanation of the trade-off, shown before the user commits. */
    note: string
  }
}

export interface EmailConnectOAuthRequest {
  provider: 'gmail' | 'microsoft'
  /** Pre-seeds the account record; overwritten by the provider's own profile. */
  address?: string
  /** Optional custom OAuth client, for users who prefer their own. */
  oauthClientId?: string
  oauthClientSecret?: string
}

export interface EmailConnectPasswordRequest {
  address: string
  password: string
  displayName?: string
  imap: EmailEndpoint
  smtp: EmailEndpoint
}
