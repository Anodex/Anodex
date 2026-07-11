import type { Conversation } from '@shared/conversation.types'
import type { TranscriptRecallResult } from '@shared/transcriptRecall.types'
import type { TranscriptRecallSettings } from '@shared/settings.types'
import { searchTranscripts } from '@shared/transcriptSearch'
import { conversationStore } from '../conversations/ConversationStore'

export interface BuildTranscriptRecallContextOptions {
  /** Excluded from candidates — never recall the conversation currently being generated. */
  conversationId: string
  /** The active project, or null for a general chat. */
  projectId: string | null
  query: string
  settings: TranscriptRecallSettings
  /** False for a cloud generation when `settings.cloudProviderEnabled` is off. */
  allowedForProvider: boolean
}

export interface TranscriptRecallContext {
  /** Rendered prompt text for the `# Past chats` reference-data section. */
  text: string
  /** The raw results, for `RunGenerationResult.transcriptRecallUsed` (UI provenance). */
  results: TranscriptRecallResult[]
}

/**
 * Automatic, tool-free cross-session transcript recall — see
 * `transcriptSearch.ts` for the scoring itself. Scoped per
 * `settings.transcriptRecall`: by default, only the active project's own
 * chats (or general chats only, in a non-project chat) are searched;
 * `crossScopeEnabled`/`archivedEnabled` are explicit opt-ins, matching this
 * project's existing "no fallback beyond genuine matches" and "don't widen
 * scope without the user asking" discipline elsewhere in project recall.
 */
export function buildTranscriptRecallContext(
  options: BuildTranscriptRecallContextOptions
): TranscriptRecallContext | null {
  if (!options.settings.enabled || !options.allowedForProvider) return null

  const candidates = gatherCandidates(options.projectId, options.settings)
  const results = searchTranscripts(candidates, options.query, {
    excludeConversationId: options.conversationId
  })
  if (results.length === 0) return null

  return { text: renderResults(results), results }
}

function gatherCandidates(
  projectId: string | null,
  settings: TranscriptRecallSettings
): Conversation[] {
  if (settings.crossScopeEnabled) {
    return settings.archivedEnabled ? conversationStore.listAll() : conversationStore.list()
  }
  return settings.archivedEnabled
    ? conversationStore.listAll().filter((c) => c.projectId === projectId)
    : conversationStore.listByProject(projectId)
}

function renderResults(results: TranscriptRecallResult[]): string {
  const lines: string[] = []
  for (const result of results) {
    const when = new Date(result.updatedAt).toISOString().slice(0, 10)
    lines.push(`## "${result.title}" (${when})`)
    for (const excerpt of result.excerpts) {
      lines.push(`- ${excerpt.role}: ${excerpt.text}`)
    }
  }
  return lines.join('\n')
}
