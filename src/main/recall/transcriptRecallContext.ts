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
  /**
   * One rendered block per result in `results`, same order and same length.
   *
   * A recalled conversation is indivisible: its heading dates the excerpts
   * beneath it, and half a block is an excerpt with no idea which chat or when.
   * The shared packer drops whole blocks, and the 1:1 pairing is what lets the
   * caller report exactly the excerpts the model was given. See
   * `AutomaticReferenceSource` in `contextPlanner.ts`.
   */
  blocks: string[]
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

  const blocks = results.map(renderResult)
  return { text: blocks.join('\n'), results, blocks }
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

/** One recalled conversation: its dated heading and the excerpts under it. */
function renderResult(result: TranscriptRecallResult): string {
  const when = new Date(result.updatedAt).toISOString().slice(0, 10)
  const lines = [`## "${result.title}" (${when})`]
  for (const excerpt of result.excerpts) {
    lines.push(`- ${excerpt.role}: ${excerpt.text}`)
  }
  return lines.join('\n')
}
