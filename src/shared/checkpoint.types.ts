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
