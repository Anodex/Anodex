import { useEffect, useState } from 'react'
import type {
  EmailAttachmentSummary,
  EmailMailbox,
  EmailMessage,
  EmailThreadSummary
} from '@shared/email.types'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/ui/Button'
import { useEmailStore } from '../../stores/emailStore'
import { useChatStore } from '../../stores/chatStore'
import { notifyError, useUiStore } from '../../stores/uiStore'
import { anodex } from '../../lib/anodex'
import { HtmlMessageBody } from './HtmlMessageBody'
import styles from './EmailView.module.css'

const PROVIDER_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  microsoft: 'Outlook',
  imap: 'IMAP',
  none: 'No account'
}

/** Providers with a web interface the "Open webmail" button can reach. */
const WEBMAIL_PROVIDERS = new Set(['gmail', 'microsoft'])

export function EmailView(): JSX.Element {
  const status = useEmailStore((s) => s.status)
  const threads = useEmailStore((s) => s.threads)
  const unreadCount = useEmailStore((s) => s.unreadCount)
  const activeAccountId = useEmailStore((s) => s.activeAccountId)
  const openThreadId = useEmailStore((s) => s.openThreadId)
  const openMessages = useEmailStore((s) => s.openMessages)
  const openLoading = useEmailStore((s) => s.openLoading)
  const busyThreadId = useEmailStore((s) => s.busyThreadId)
  const storedQuery = useEmailStore((s) => s.query)
  const mailbox = useEmailStore((s) => s.mailbox)
  const mailboxes = useEmailStore((s) => s.mailboxes)
  const hasMore = useEmailStore((s) => s.hasMore)
  const loadingMore = useEmailStore((s) => s.loadingMore)
  const selectMailbox = useEmailStore((s) => s.selectMailbox)
  const loadMore = useEmailStore((s) => s.loadMore)
  const loadMailboxes = useEmailStore((s) => s.loadMailboxes)
  const selectAccount = useEmailStore((s) => s.selectAccount)
  const openThread = useEmailStore((s) => s.openThread)
  const closeThread = useEmailStore((s) => s.closeThread)
  const applyFlag = useEmailStore((s) => s.applyFlag)
  const runSearch = useEmailStore((s) => s.search)
  const loadEmail = useEmailStore((s) => s.load)

  const [queryInput, setQueryInput] = useState(storedQuery)

  useEffect(() => {
    void loadEmail()
    void loadMailboxes()
  }, [loadEmail, loadMailboxes])

  const accounts = status?.accounts ?? []
  const active =
    accounts.find((account) => account.id === activeAccountId) ??
    accounts.find((account) => account.isPrimary) ??
    accounts[0]
  const openThreadSummary = threads.find((thread) => thread.id === openThreadId) ?? null

  const handleOpenWebmail = async (): Promise<void> => {
    const result = await anodex.email.openWebmail()
    if (!result.ok) {
      notifyError('Could not open webmail', result.error.detail ?? result.error.message)
    }
  }

  const submitSearch = (event: React.FormEvent): void => {
    event.preventDefault()
    void runSearch(queryInput)
  }

  const clearSearch = (): void => {
    setQueryInput('')
    void runSearch('')
  }

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Email</h1>
          <p className={styles.subtitle}>
            {accounts.length === 0
              ? 'Link a mailbox in Settings to search, summarize, and reply from here.'
              : `${accounts.length} account${accounts.length === 1 ? '' : 's'} linked${
                  unreadCount > 0 ? ` · ${unreadCount} unread` : ''
                }`}
          </p>
        </div>
        <div className={styles.headerActions}>
          {status && WEBMAIL_PROVIDERS.has(status.provider) && (
            <Button
              variant="secondary"
              iconLeft={<Icon name="web" size={16} />}
              onClick={() => void handleOpenWebmail()}
            >
              Open webmail
            </Button>
          )}
          <Button
            variant="secondary"
            iconLeft={<Icon name="refresh" size={16} />}
            onClick={() => void loadEmail()}
          >
            Refresh
          </Button>
        </div>
      </div>

      {accounts.length > 1 && (
        <div className={styles.accountTabs}>
          {accounts.map((account) => (
            <button
              key={account.id}
              type="button"
              className={`${styles.accountTab} ${
                account.id === active?.id ? styles.accountTabActive : ''
              }`}
              onClick={() => void selectAccount(account.id)}
            >
              {account.address}
            </button>
          ))}
        </div>
      )}

      {active?.connected && mailboxes.length > 0 && (
        <div className={styles.mailboxTabs}>
          {orderMailboxes(mailboxes).map((candidate) => {
            const isInbox = candidate.name.toUpperCase() === 'INBOX'
            const selected = isInbox ? mailbox === null : mailbox === candidate.name
            return (
              <button
                key={candidate.id}
                type="button"
                className={`${styles.accountTab} ${selected ? styles.accountTabActive : ''}`}
                onClick={() => void selectMailbox(isInbox ? null : candidate.name)}
              >
                {friendlyMailboxName(candidate.name)}
              </button>
            )
          })}
        </div>
      )}

      {active?.connected && (
        <form className={styles.searchRow} onSubmit={submitSearch}>
          <Icon name="search" size={16} />
          <input
            className={styles.searchInput}
            value={queryInput}
            placeholder="Search mail — sender, subject, or keywords"
            onChange={(event) => setQueryInput(event.target.value)}
          />
          {storedQuery && (
            <Button variant="ghost" size="sm" onClick={clearSearch}>
              Clear
            </Button>
          )}
          <Button variant="secondary" size="sm" type="submit">
            Search
          </Button>
        </form>
      )}

      <section className={styles.mailboxPanel}>
        <div className={styles.mailboxHeader}>
          <h2>
            {storedQuery
              ? `Results for "${storedQuery}"`
              : mailbox
                ? friendlyMailboxName(mailbox)
                : 'Inbox'}
          </h2>
          <span>
            {active
              ? `${active.address} · ${PROVIDER_LABELS[active.provider] ?? active.provider}`
              : PROVIDER_LABELS.none}
          </span>
        </div>

        {!active?.connected ? (
          <div className={styles.emptyInbox}>
            <Icon name="mail" size={32} />
            <p>
              {active
                ? (active.reason ?? 'Reconnect this account in Settings to read its inbox.')
                : 'Add an account in Settings → Email to read, summarize, draft, and send from this page.'}
            </p>
          </div>
        ) : openThreadId ? (
          <ThreadReader
            summary={openThreadSummary}
            messages={openMessages}
            loading={openLoading}
            onClose={closeThread}
          />
        ) : threads.length === 0 ? (
          <div className={styles.emptyInbox}>
            <Icon name="mail" size={32} />
            <p>{storedQuery ? 'No messages matched that search.' : 'No recent inbox threads.'}</p>
          </div>
        ) : (
          <div className={styles.threadList}>
            {threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                busy={busyThreadId === thread.id}
                onOpen={() => void openThread(thread)}
                onFlag={(action) => void applyFlag(thread, action)}
              />
            ))}
            {hasMore && (
              <div className={styles.loadMoreRow}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

interface ThreadRowProps {
  thread: EmailThreadSummary
  busy: boolean
  onOpen: () => void
  onFlag: (action: 'mark_read' | 'mark_unread' | 'star' | 'archive') => void
}

function ThreadRow({ thread, busy, onOpen, onFlag }: ThreadRowProps): JSX.Element {
  return (
    <div className={`${styles.threadItem} ${thread.unread ? styles.threadUnread : ''}`}>
      <button type="button" className={styles.threadOpen} onClick={onOpen}>
        <div className={styles.threadTitleRow}>
          <strong>
            {thread.unread && <span className={styles.unreadDot} aria-label="Unread" />}
            {thread.subject}
          </strong>
          <span>{new Date(thread.updatedAt).toLocaleDateString()}</span>
        </div>
        <p>{thread.from}</p>
        <small>{thread.snippet}</small>
      </button>

      <div className={styles.threadActions}>
        <IconAction
          label={thread.unread ? 'Mark as read' : 'Mark as unread'}
          icon={thread.unread ? 'check' : 'mail'}
          disabled={busy}
          onClick={() => onFlag(thread.unread ? 'mark_read' : 'mark_unread')}
        />
        <IconAction label="Star" icon="star" disabled={busy} onClick={() => onFlag('star')} />
        <IconAction
          label="Archive"
          icon="archive"
          disabled={busy}
          onClick={() => onFlag('archive')}
        />
      </div>
    </div>
  )
}

interface IconActionProps {
  label: string
  icon: Parameters<typeof Icon>[0]['name']
  disabled: boolean
  onClick: () => void
}

function IconAction({ label, icon, disabled, onClick }: IconActionProps): JSX.Element {
  return (
    <button
      type="button"
      className={styles.iconAction}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={15} />
    </button>
  )
}

interface ThreadReaderProps {
  summary: EmailThreadSummary | null
  messages: EmailMessage[]
  loading: boolean
  onClose: () => void
}

function ThreadReader({ summary, messages, loading, onClose }: ThreadReaderProps): JSX.Element {
  const openEmailThreadConversation = useChatStore((s) => s.openEmailThreadConversation)
  const setPendingComposerText = useChatStore((s) => s.setPendingComposerText)
  const setView = useUiStore((s) => s.setView)

  /**
   * Hands the thread to chat with the instruction pre-written rather than
   * composing here. The model drafts through `reply_email`, which keeps the
   * existing approval gate in front of anything actually being sent.
   */
  const handOffToChat = (instruction: string, message: EmailMessage): void => {
    // The ids come along because the email tools address messages by id, not by
    // subject — without them the model would have to search the mailbox again
    // and might well act on the wrong message.
    setPendingComposerText(
      [
        instruction,
        '',
        `It is the message "${message.subject}" from ${message.from}.`,
        `Use account ${message.accountId}, messageId ${message.id}, threadId ${message.threadId}.`
      ].join('\n')
    )
    // Returns to the chat already discussing this thread when one is still
    // around, so a second Reply click continues the conversation rather than
    // starting a parallel one that has lost all the earlier context.
    openEmailThreadConversation(message.accountId, message.threadId)
    setView('chat')
  }

  if (loading) {
    return (
      <div className={styles.emptyInbox}>
        <p>Opening conversation…</p>
      </div>
    )
  }

  const latest = messages[messages.length - 1]

  return (
    <div className={styles.reader}>
      <div className={styles.readerHeader}>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          iconLeft={<Icon name="chevron-left" size={14} />}
        >
          Back to list
        </Button>
        {latest && (
          <div className={styles.readerActions}>
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Icon name="chat" size={14} />}
              onClick={() => handOffToChat('Summarize this email thread for me.', latest)}
            >
              Summarize
            </Button>
            <Button
              variant="primary"
              size="sm"
              iconLeft={<Icon name="pencil" size={14} />}
              onClick={() =>
                handOffToChat('Draft a reply to this email and send it once I approve.', latest)
              }
            >
              Reply
            </Button>
          </div>
        )}
      </div>

      <h3 className={styles.readerSubject}>
        {summary?.subject ?? latest?.subject ?? '(no subject)'}
      </h3>

      {messages.length === 0 ? (
        <div className={styles.emptyInbox}>
          <p>This conversation has no readable messages.</p>
        </div>
      ) : (
        <div className={styles.messageList}>
          {messages.map((message) => (
            <article key={message.id} className={styles.message}>
              <div className={styles.messageMeta}>
                <strong>{message.from}</strong>
                <span>{new Date(message.date).toLocaleString()}</span>
              </div>
              {message.to.length > 0 && (
                <div className={styles.messageRecipients}>To: {message.to.join(', ')}</div>
              )}
              {message.bodyHtml ? (
                <HtmlMessageBody html={message.bodyHtml} />
              ) : (
                <div className={styles.messageBody}>
                  {message.body.trim() || message.snippet || '(no readable body)'}
                </div>
              )}
              {message.attachments.length > 0 && (
                <div className={styles.attachmentRow}>
                  {message.attachments.map((attachment) => (
                    <AttachmentChip
                      key={attachment.id}
                      attachment={attachment}
                      accountId={message.accountId}
                    />
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

interface AttachmentChipProps {
  attachment: EmailAttachmentSummary
  accountId: string
}

/** An attachment the user can actually get at, rather than just read the name of. */
function AttachmentChip({ attachment, accountId }: AttachmentChipProps): JSX.Element {
  const [saving, setSaving] = useState(false)
  const notify = useUiStore((s) => s.notify)

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await anodex.email.saveAttachment({
        messageId: attachment.messageId,
        attachmentId: attachment.id,
        filename: attachment.filename,
        accountId
      })
      if (!result.ok) {
        notifyError('Could not save attachment', result.error.detail ?? result.error.message)
        return
      }
      // A null path means the save dialog was dismissed, which is not an event
      // worth announcing.
      if (result.value.path) {
        notify({ kind: 'success', title: 'Attachment saved', message: result.value.path })
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <button
      type="button"
      className={styles.attachmentChip}
      disabled={saving}
      title={`Save ${attachment.filename}`}
      onClick={() => void handleSave()}
    >
      <Icon name={saving ? 'refresh' : 'download'} size={13} />
      {attachment.filename}
      <small>{formatBytes(attachment.size)}</small>
    </button>
  )
}

/** Inbox first, then the mailboxes people actually switch to, then the rest. */
function orderMailboxes(mailboxes: EmailMailbox[]): EmailMailbox[] {
  const rank = (name: string): number => {
    const key = friendlyMailboxName(name).toLowerCase()
    const order = ['inbox', 'sent', 'drafts', 'archive', 'all mail', 'starred', 'spam', 'trash']
    const index = order.indexOf(key)
    return index === -1 ? order.length : index
  }
  return [...mailboxes]
    .sort(
      (left, right) => rank(left.name) - rank(right.name) || left.name.localeCompare(right.name)
    )
    .slice(0, 8)
}

/** Strips the server's namespace prefix, e.g. `[Gmail]/Sent Mail` -> `Sent Mail`. */
function friendlyMailboxName(name: string): string {
  const trimmed = name.replace(/^\[[^\]]+\][/.]?/, '').trim()
  const leaf = trimmed.split(/[/.]/).pop()?.trim()
  return leaf || name
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
