import type { Conversation } from '@shared/conversation.types'
import { wordSet } from '@shared/textSimilarity'

/**
 * Every word a search could match in one conversation, as a single string:
 * ` bug report crash `.
 *
 * Chats past the newest few keep their messages on disk (see `RECENT_CHATS_HELD`),
 * so searching them used to mean reading and parsing every one — 48MB on this
 * machine, for every character typed into the sidebar, all of it then held in
 * memory for two minutes. That is the whole of what the change to read chats
 * lazily was meant to avoid.
 *
 * A digest is what survives of a chat once you only need to know whether it is
 * worth opening: the same words `searchTranscripts` scores against, each kept
 * once. Measured on that machine, every chat in the store — archived ones
 * included — digests to 1MB in 98ms, against 140MB of messages.
 *
 * A string rather than a `Set`: this is scanned, never iterated, and one string
 * per chat costs a fraction of what a set of short strings does.
 */
export function wordDigestOf(conversation: Conversation): string {
  const words = new Set<string>()
  for (const message of conversation.messages) {
    // The messages `searchTranscripts` will score — see `isIndexable` there.
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (message.content.trim().length === 0) continue
    for (const word of wordSet(message.content)) words.add(word)
  }
  return ` ${[...words].join(' ')} `
}

/**
 * Could a conversation with this digest hold a message that a search for
 * `queryWords` would surface? Necessary, never sufficient — a chat that passes
 * is opened and scored properly; a chat that fails cannot score at all.
 *
 * `searchTranscripts` surfaces a message scoring `MIN_SCORE` (2), and a message
 * scores one per distinct query word it contains plus three for carrying the
 * query verbatim. A one-word query therefore needs that word; a longer query
 * needs two of its words, because the verbatim phrase contains them all.
 *
 * Asked as *substrings*, not whole words, because the verbatim match is a
 * substring: searching for "checkpoint" surfaces a chat that only ever said
 * "checkpoints", and against the real store a whole-word test dropped four such
 * chats out of twenty-five. A query word is letters and digits only, so it can
 * only ever sit inside one word of the text — and that word is in the digest.
 */
export function couldMatch(digest: string, queryWords: Set<string>): boolean {
  if (queryWords.size === 0) return false
  const needed = Math.min(2, queryWords.size)
  let found = 0
  for (const word of queryWords) {
    if (!digest.includes(word)) continue
    found += 1
    if (found >= needed) return true
  }
  return false
}
