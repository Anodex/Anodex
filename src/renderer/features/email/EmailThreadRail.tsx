import { useEffect } from 'react'
import type { EmailMessage, EmailThreadSummary } from '@shared/email.types'
import { Icon } from '../../components/Icon'
import { useChatStore } from '../../stores/chatStore'
import { MessageList } from '../chat/MessageList'
import { ChatComposer } from '../chat/ChatComposer'
import styles from './EmailThreadRail.module.css'

/**
 * The conversation about the open email thread, docked beside it.
 *
 * This is the same chat the Chat page shows — the rail selects the thread's
 * linked conversation rather than rendering a second, parallel one, so asking
 * a question here and then switching to Chat continues one discussion instead
 * of splitting it in two. That also means the composer, tool cards, and the
 * approval gate are the real ones, not email-specific copies that could drift
 * out of step with the originals.
 */
export function EmailThreadRail({
  thread,
  messages,
  onCollapse
}: {
  thread: EmailThreadSummary
  messages: EmailMessage[]
  onCollapse: () => void
}): JSX.Element {
  const openEmailThreadConversation = useChatStore((s) => s.openEmailThreadConversation)
  const setPendingComposerText = useChatStore((s) => s.setPendingComposerText)
  const discardUnusedEmailThreadConversation = useChatStore(
    (s) => s.discardUnusedEmailThreadConversation
  )
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === s.activeId) ?? null)

  const latest = messages[messages.length - 1] ?? null
  const latestMessageId = latest?.id

  // Selecting the linked conversation is what makes the shared composer and
  // transcript below address this thread — they both read the active chat.
  // Re-runs when the newest message changes so a reply drafted after new mail
  // arrives answers the new message rather than the one that was newest when
  // the rail first opened.
  //
  // Linking has to happen up front rather than on the first question, because
  // the composer sends to whatever chat is active — so the cleanup drops the
  // chat again if the user just read the mail and moved on.
  useEffect(() => {
    const id = openEmailThreadConversation(thread.accountId, thread.id, {
      subject: thread.subject,
      latestMessageId
    })
    return () => discardUnusedEmailThreadConversation(id)
  }, [
    openEmailThreadConversation,
    discardUnusedEmailThreadConversation,
    thread.accountId,
    thread.id,
    thread.subject,
    latestMessageId
  ])

  // Guards against rendering the wrong chat for one frame: the effect above
  // runs after this render, so on the first pass `conversation` is still
  // whatever was active before — usually an unrelated chat.
  const linked =
    conversation?.emailThread?.threadId === thread.id &&
    conversation.emailThread.accountId === thread.accountId
      ? conversation
      : null

  const ask = (instruction: string): void => setPendingComposerText(instruction)

  return (
    <aside className={styles.rail} aria-label="Assistant for this conversation">
      <div className={styles.railHeader}>
        <span className={styles.railTitle}>
          <Icon name="sparkle" size={13} />
          About this thread
        </span>
        <button
          type="button"
          className={styles.railButton}
          onClick={onCollapse}
          title="Hide the assistant"
          aria-label="Hide the assistant"
        >
          <Icon name="panel-right" size={14} />
        </button>
      </div>

      {linked && linked.messages.length > 0 ? (
        <MessageList messages={linked.messages} context={linked.context} />
      ) : (
        <div className={styles.starters}>
          <p className={styles.startersLead}>
            Ask about this conversation, or start with one of these. Nothing is sent to{' '}
            {shortSender(thread.from)} without your approval.
          </p>
          <button
            type="button"
            className={styles.starter}
            onClick={() => ask('Summarize this email thread for me.')}
          >
            <Icon name="insight" size={13} />
            Summarize the thread
          </button>
          <button
            type="button"
            className={styles.starter}
            onClick={() => ask('What is this thread actually asking me to do?')}
          >
            <Icon name="info" size={13} />
            What does it want from me?
          </button>
          <button
            type="button"
            className={styles.starter}
            disabled={!latest}
            onClick={() => ask('Draft a reply to this email and send it once I approve.')}
          >
            <Icon name="pencil" size={13} />
            Draft a reply
          </button>
        </div>
      )}

      <ChatComposer />
    </aside>
  )
}

/** `Dana Okafor <dana@…>` reads better as just the name in running prose. */
function shortSender(from: string): string {
  const name = from.replace(/<[^>]*>/, '').trim()
  return name.replace(/^"|"$/g, '') || from
}
