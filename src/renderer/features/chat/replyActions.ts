import type { ChatMessage } from '@shared/chat.types'

/**
 * Which page a reply changed to open in the browser, or null when it changed none.
 *
 * The site's front page when it was among them, since that is where a visitor
 * starts; otherwise the first page changed.
 */
export function webPageToOpen(changedFiles: readonly string[] | undefined): string | null {
  const pages = (changedFiles ?? []).filter((path) => /\.html?$/i.test(path))
  if (pages.length === 0) return null
  const normalized = (path: string): string => path.split('\\').join('/')
  const front = pages
    .filter((path) => /(^|\/)index\.html?$/i.test(normalized(path)))
    .sort((a, b) => normalized(a).split('/').length - normalized(b).split('/').length)[0]
  return front ?? pages[0]
}

/** What Continue sends: the same instruction the runner itself resumes a reply with. */
export const CONTINUE_MESSAGE = 'Continue from where you stopped.'

/**
 * Whether a reply ended in an error partway through its work, and so can be continued
 * rather than only asked again.
 *
 * Regenerate throws the work away and starts over. A reply that failed after writing
 * half a website — seen when two builds overflowed the model's memory — kept all of
 * it, and the only way on was to type "continue". Only the newest reply: continuing an
 * older one would answer a question the conversation has moved past.
 */
export function canContinueReply(message: ChatMessage, isNewestReply: boolean): boolean {
  if (message.role !== 'assistant' || message.streaming || !message.error || !isNewestReply) {
    return false
  }
  const wroteSomething = message.content.trim().length > 0
  const didSomething = message.toolCalls?.some((call) => call.status === 'success') ?? false
  return wroteSomething || didSomething
}
