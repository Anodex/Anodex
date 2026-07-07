/**
 * Structured, retrieval-ranked memory — distinct from `projectMemory.types.ts`'s
 * activity ledger (recently touched files, task summaries). An entry here is a
 * durable fact the assistant was explicitly told to remember (via the
 * `remember_fact` tool, or added by hand in Settings → Memory), not something
 * inferred from ambient activity.
 *
 * Scoped to either one project ("cross-chat memory" — recalled across every
 * conversation in that project) or globally ("personal memory" — recalled in
 * every project). Both scopes can be turned off independently in Settings →
 * Memory; turning a scope off stops it being read or written, but never
 * deletes what's already stored.
 */

/**
 * `identity` facts (who the user is — their name, etc.) are ranked ahead of
 * everything but pinned entries during retrieval (see `MemoryRetriever.ts`),
 * since a direct question like "what's my name?" often shares no words at all
 * with how the fact was phrased when it was saved.
 */
export type MemoryKind = 'identity' | 'convention' | 'gotcha' | 'preference' | 'open_task'

export type MemoryScope = { type: 'project'; projectId: string } | { type: 'global' }

export interface MemoryEntry {
  id: string
  kind: MemoryKind
  text: string
  scope: MemoryScope
  /** Where this memory came from, if known. */
  source?: { conversationId?: string }
  createdAt: number
  updatedAt: number
  /** Pinned entries are never evicted by the storage cap and are always retrieved first. */
  pinned: boolean
  /** Archived entries are kept on disk but excluded from retrieval and the default list view. */
  archived: boolean
}

export interface CreateMemoryRequest {
  kind: MemoryKind
  text: string
  scope: MemoryScope
  source?: { conversationId?: string }
}

export interface UpdateMemoryRequest {
  text?: string
  kind?: MemoryKind
  pinned?: boolean
  archived?: boolean
}
