import { useEffect, useState } from 'react'
import type { ConversationSearchHit } from '@shared/conversation.types'
import { anodex } from '../../lib/anodex'

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
 * How long typing has to pause before the computer is asked. Searching every
 * conversation's messages is the computer's work now — the window no longer holds
 * them — and one search per keystroke would queue work nobody reads.
 */
export const BODY_SEARCH_DEBOUNCE_MS = 150

export interface SidebarSearchMatches {
  /** Ids of conversations matching on message content. */
  ids: Set<string>
  /** Best-matching excerpt per conversation id, for display under the title. */
  excerpts: Map<string, string>
}

const EMPTY: SidebarSearchMatches = { ids: new Set(), excerpts: new Map() }

/**
 * The computer's body-search hits as the sidebar reads them.
 *
 * The ranking is `transcriptSearch`'s, run by `conversations:search` where the
 * messages are, with the same cap of fifty the sidebar always used; each hit carries
 * its best excerpt already.
 */
export function matchesFromHits(hits: ConversationSearchHit[]): SidebarSearchMatches {
  if (hits.length === 0) return EMPTY
  const ids = new Set<string>()
  const excerpts = new Map<string, string>()
  for (const hit of hits) {
    ids.add(hit.conversationId)
    if (hit.excerpt) excerpts.set(hit.conversationId, hit.excerpt)
  }
  return { ids, excerpts }
}

/**
 * Conversations whose messages match `query`, asked of the computer once typing
 * pauses. Nothing for an empty query, and nothing — titles still match — when the
 * search cannot be run.
 */
export function useBodyMatches(query: string): SidebarSearchMatches {
  const [matches, setMatches] = useState<SidebarSearchMatches>(EMPTY)
  const trimmed = query.trim()

  useEffect(() => {
    if (!trimmed) {
      setMatches(EMPTY)
      return
    }
    let current = true
    const timer = setTimeout(() => {
      anodex.conversations
        .search(trimmed)
        .then((hits) => {
          if (current) setMatches(matchesFromHits(hits))
        })
        .catch(() => {
          if (current) setMatches(EMPTY)
        })
    }, BODY_SEARCH_DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [trimmed])

  return trimmed ? matches : EMPTY
}

/** Whether `text` contains `query`, case-insensitively. */
export function matchesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase())
}
