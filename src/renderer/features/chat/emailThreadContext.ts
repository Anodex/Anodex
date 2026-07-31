import type { EmailThreadLink } from '@shared/conversation.types'

/**
 * Appends the ids of the email thread a chat is about to the model-facing
 * prompt only — never to the message the user sees in the transcript.
 *
 * The Email page's assistant rail is a conversation *about* one thread, but
 * `emailThread` is renderer metadata the model has no access to. Without this
 * the model would have to search the mailbox for the thread the user is
 * plainly looking at, and a local model searching for "that email" is exactly
 * the case that acts on the wrong message.
 *
 * Repeated on every turn rather than seeded once into the first message, so
 * the ids survive context compaction dropping the older turns.
 */
export function withEmailThreadContext(prompt: string, link: EmailThreadLink | undefined): string {
  if (!link) return prompt

  const facts = [
    `accountId ${link.accountId}`,
    `threadId ${link.threadId}`,
    link.latestMessageId ? `newest messageId ${link.latestMessageId}` : null
  ]
    .filter(Boolean)
    .join(', ')

  return [
    prompt,
    '',
    `[Context: this chat is about the open email thread${
      link.subject ? ` "${link.subject}"` : ''
    } — ${facts}. Use these ids with the email tools instead of searching for the thread again.]`
  ].join('\n')
}
