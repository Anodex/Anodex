import type { Conversation } from '@shared/conversation.types'
import { searchTranscripts } from '@shared/transcriptSearch'

/**
 * Sidebar search over both conversation titles and what was actually said in
 * them.
 *
 * Title-only search could never find a message you wrote, which is most of
 * what there is to find — titles are short, often auto-generated, and say
 * nothing about the contents. The scoring is not new: `transcriptSearch.ts`
 * already ranks transcripts and cuts excerpts for the *model's* cross-session
 * recall, and this points the same function at the user.
 *
 * Body matches carry an excerpt so a row that appears for no visible reason
 * can say why it did. A title match doesn't get one — the reason is already
 * on screen.
 */

/**
 * Deliberately far above `transcriptSearch`'s own default of 3. That default
 * bounds how much gets injected into a prompt; here the only cost is list
 * length, and a search that silently caps at three hits would be worse than
 * no search at all.
 */
const MAX_BODY_MATCHES = 50

export interface SidebarSearchMatches {
  /** Ids of conversations matching on message content. */
  ids: Set<string>
  /** Best-matching excerpt per conversation id, for display under the title. */
  excerpts: Map<string, string>
}

const EMPTY: SidebarSearchMatches = { ids: new Set(), excerpts: new Map() }

/** Rank `conversations` by what their messages say. Empty query yields no matches. */
export function findBodyMatches(
  conversations: Conversation[],
  query: string
): SidebarSearchMatches {
  if (!query.trim()) return EMPTY

  const results = searchTranscripts(conversations, query, { maxResults: MAX_BODY_MATCHES })
  const ids = new Set<string>()
  const excerpts = new Map<string, string>()
  for (const result of results) {
    ids.add(result.conversationId)
    // `searchTranscripts` returns excerpts already sorted by score, so the
    // first is the strongest reason this conversation surfaced.
    const best = result.excerpts[0]
    if (best) excerpts.set(result.conversationId, best.text)
  }
  return { ids, excerpts }
}

/** Whether `text` contains `query`, case-insensitively. */
export function matchesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase())
}
