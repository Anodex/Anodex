import type { Conversation } from './conversation.types'
import type { ChatMessage } from './chat.types'
import type { TranscriptRecallExcerpt, TranscriptRecallResult } from './transcriptRecall.types'
import { wordSet } from './textSimilarity'

/**
 * Pure lexical search over conversation transcripts. No embeddings, no
 * SQLite/FTS5, no persisted index — `ConversationStore`'s in-memory cache
 * (main process) or the renderer's own already-loaded conversation list is
 * scanned directly. At this app's real scale (a single local user, dozens to
 * low hundreds of conversations) a live scored scan is cheap; an actual
 * inverted index is only worth the complexity if a benchmark ever shows
 * otherwise.
 */

/** Preview length for a surfaced excerpt — bounded, not the full message. */
const MAX_EXCERPT_CHARS = 300
const MAX_EXCERPTS_PER_CONVERSATION = 3
const MAX_RESULTS = 3
/** Flat bonus when the query appears verbatim as a substring, not just as scattered word overlap. */
const PHRASE_BOOST = 3
/** Below this length a literal-substring match is too likely to be noise (e.g. a 2-letter query) to boost on. */
const MIN_PHRASE_LENGTH = 4

export interface SearchTranscriptsOptions {
  /** Excluded from results — never recall the conversation currently being generated. */
  excludeConversationId?: string
  maxResults?: number
  maxExcerptsPerConversation?: number
}

/**
 * Rank conversations by lexical relevance to `query`, returning up to
 * `maxResults` conversations with up to `maxExcerptsPerConversation` scored
 * excerpts each. Returns `[]` for an empty/too-short query or when nothing
 * matches — no "show recent activity anyway" fallback, same discipline as
 * `workspaceContext.ts`'s project recall (see that file's comment on why:
 * this project has a documented history of exactly that fallback shape
 * causing unrelated-context bleed into a new task).
 */
export function searchTranscripts(
  conversations: Conversation[],
  query: string,
  options: SearchTranscriptsOptions = {}
): TranscriptRecallResult[] {
  const queryWords = wordSet(query)
  if (queryWords.size === 0) return []
  const queryPhrase = query.trim().toLowerCase()
  const maxExcerpts = options.maxExcerptsPerConversation ?? MAX_EXCERPTS_PER_CONVERSATION

  const scoredConversations: Array<{ result: TranscriptRecallResult; score: number }> = []

  for (const conversation of conversations) {
    if (conversation.id === options.excludeConversationId) continue

    const scoredMessages = conversation.messages
      .filter(isIndexable)
      .map((message) => ({
        message,
        score: scoreText(message.content, queryWords, queryPhrase)
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxExcerpts)

    if (scoredMessages.length === 0) continue

    const excerpts: TranscriptRecallExcerpt[] = scoredMessages.map(({ message, score }) => ({
      messageId: message.id,
      role: message.role as 'user' | 'assistant',
      text: truncate(message.content, MAX_EXCERPT_CHARS),
      score
    }))

    scoredConversations.push({
      result: {
        conversationId: conversation.id,
        projectId: conversation.projectId,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        excerpts
      },
      // A conversation's rank is its single best-matching excerpt — a single
      // strongly relevant message shouldn't be outranked by a conversation
      // with several weakly-relevant ones.
      score: Math.max(...scoredMessages.map((entry) => entry.score))
    })
  }

  return scoredConversations
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      return b.result.updatedAt - a.result.updatedAt
    })
    .slice(0, options.maxResults ?? MAX_RESULTS)
    .map((entry) => entry.result)
}

/** User/assistant prose only — excludes system messages, tool payloads (a separate field), and attachments. */
function isIndexable(message: ChatMessage): boolean {
  return (
    (message.role === 'user' || message.role === 'assistant') && message.content.trim().length > 0
  )
}

function scoreText(text: string, queryWords: Set<string>, queryPhrase: string): number {
  let score = 0
  for (const word of wordSet(text)) {
    if (queryWords.has(word)) score++
  }
  if (queryPhrase.length >= MIN_PHRASE_LENGTH && text.toLowerCase().includes(queryPhrase)) {
    score += PHRASE_BOOST
  }
  return score
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}
