import type { UnifiedDiffLine } from './diffRows'

export type CheckpointFileChangeKind = 'created' | 'modified' | 'deleted'
export type CheckpointContentEncoding = 'utf8' | 'base64'

export interface CheckpointFileChange {
  path: string
  before: string | null
  after: string | null
  beforeEncoding?: CheckpointContentEncoding
  afterEncoding?: CheckpointContentEncoding
}

export interface CheckpointSummary {
  conversationId: string
  messageId: string
  changedFiles: string[]
  restoredFiles?: string[]
  restoredAt?: number
}

export interface CheckpointHistoryEntry extends CheckpointSummary {
  createdAt: number
}

export interface CheckpointRequest {
  projectId: string
  conversationId: string
  messageId: string
}

export interface CheckpointFilePreview {
  path: string
  kind: CheckpointFileChangeKind
  before: string | null
  after: string | null
  binary: boolean
  beforeSize: number | null
  afterSize: number | null
  conflicted: boolean
  restored: boolean
}

export interface CheckpointPreview extends CheckpointSummary {
  files: CheckpointFilePreview[]
}

export interface CheckpointFileDiffRequest extends CheckpointRequest {
  /** One of the paths `inspect` reported for this turn. */
  path: string
}

/**
 * What one file's change looks like, drawn on the machine that has the file.
 *
 * `inspect` deliberately strips file contents before they go on a socket, which
 * leaves a remote client able to say *that* a file changed and never *what*
 * changed in it. Sending the contents instead is the wrong fix: a checkpoint
 * holds the whole before and after, and one rewritten file becomes a frame too
 * big to send.
 *
 * A diff is smaller than either side of it, because unchanged lines away from a
 * change are collapsed — so the answer is built here, where the diff code
 * already lives, and what crosses the wire is the part a person would read.
 */
export interface CheckpointFileDiff {
  path: string
  kind: CheckpointFileChangeKind
  /** No rows: there is nothing to draw, and saying why is the useful answer. */
  binary: boolean
  added: number
  removed: number
  rows: UnifiedDiffLine[]
  /**
   * The change was larger than a phone should be sent, so `rows` stops early.
   * The counts above are still the whole truth — they are counted before the cut.
   */
  truncated: boolean
}

export interface RestoreCheckpointRequest extends CheckpointRequest {
  paths: string[]
  force?: boolean
}

export interface RestoreCheckpointResult {
  restoredFiles: string[]
  conflicts: string[]
  checkpoint: CheckpointSummary
}

export interface UndoCheckpointRequest extends CheckpointRequest {
  paths: string[]
  force?: boolean
}

export interface UndoCheckpointResult {
  undoneFiles: string[]
  conflicts: string[]
  checkpoint: CheckpointSummary
}

export interface RollbackCheckpointsRequest {
  projectId: string
  conversationId: string
  /** Assistant message ids in transcript order, oldest first. */
  messageIds: string[]
  /** Paths to leave untouched across every discarded checkpoint. */
  excludePaths?: string[]
  /** Restore even when the current workspace no longer matches the checkpoint chain. */
  force?: boolean
}

export interface RollbackCheckpointsResult {
  rolledBackMessages: string[]
  restoredFiles: string[]
  skippedFiles: string[]
  /** No files are changed when this is non-empty unless force was requested. */
  conflicts: string[]
}
