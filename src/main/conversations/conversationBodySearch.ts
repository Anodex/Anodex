import type { Conversation, ConversationSearchHit } from '@shared/conversation.types'
import { searchTranscripts } from '@shared/transcriptSearch'

/**
 * As many hits as a phone list is worth, and the same cap the desktop sidebar uses.
 *
 * Far above `searchTranscripts`' own default of three, which bounds what is injected
 * into a prompt. Here the only cost is a longer list.
 */
export const MAX_SEARCH_HITS = 50

/**
 * Shortest query worth running for a phone: one or two characters match nearly
 * everything, and every hit is a line in a list on a small screen.
 */
export const MIN_QUERY_CHARS = 3

/**
 * Search what was said in conversations, for a client that cannot load them all.
 *
 * The phone's search only ever matched titles, and titles are short and often
 * generated — the thing somebody remembers is a sentence from the middle of a chat.
 * This is the desktop sidebar's body search (`findBodyMatches`), run where the
 * transcripts live and answered with ids and one excerpt each, so nothing close to a
 * transcript crosses the socket.
 */
export function searchConversationBodies(
  conversations: Conversation[],
  query: string,
  /** The desktop sidebar searches from the first character, as it did in the window. */
  minQueryChars: number = MIN_QUERY_CHARS
): ConversationSearchHit[] {
  if (query.trim().length < Math.max(1, minQueryChars)) return []

  return searchTranscripts(conversations, query, { maxResults: MAX_SEARCH_HITS }).flatMap(
    (result) => {
      const best = result.excerpts[0]
      return best ? [{ conversationId: result.conversationId, excerpt: best.text }] : []
    }
  )
}
