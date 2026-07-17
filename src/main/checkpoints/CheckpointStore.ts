import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  CheckpointFileChange,
  CheckpointFileChangeKind,
  CheckpointPreview,
  CheckpointSummary,
  RestoreCheckpointResult
} from '@shared/checkpoint.types'
import { writeJsonAtomic } from '../utils/atomicWrite'
import { resolveInWorkspace } from '../tools/workspace'

interface PersistedCheckpoint {
  conversationId: string
  messageId: string
  createdAt: number
  restoredAt?: number
  restoredPaths?: string[]
  changes: CheckpointFileChange[]
}

function checkpointDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.anodex', 'checkpoints')
}

function checkpointPath(workspaceRoot: string, conversationId: string, messageId: string): string {
  return join(
    checkpointDir(workspaceRoot),
    sanitizeId(conversationId),
    `${sanitizeId(messageId)}.json`
  )
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

class CheckpointStore {
  recordChange(
    workspaceRoot: string,
    conversationId: string,
    messageId: string,
    change: CheckpointFileChange
  ): CheckpointSummary {
    const filePath = checkpointPath(workspaceRoot, conversationId, messageId)
    const existing = this.readFile(filePath)
    const changes = upsertChange(existing?.changes ?? [], change)
    const next: PersistedCheckpoint = {
      conversationId,
      messageId,
      createdAt: existing?.createdAt ?? Date.now(),
      restoredAt: existing?.restoredAt,
      restoredPaths: existing?.restoredPaths,
      changes
    }
    mkdirSync(dirname(filePath), { recursive: true })
    writeJsonAtomic(filePath, next)
    return toSummary(next)
  }

  getSummary(
    workspaceRoot: string,
    conversationId: string,
    messageId: string
  ): CheckpointSummary | null {
    const checkpoint = this.readFile(checkpointPath(workspaceRoot, conversationId, messageId))
    return checkpoint ? toSummary(checkpoint) : null
  }

  inspect(workspaceRoot: string, conversationId: string, messageId: string): CheckpointPreview {
    const checkpoint = this.requireCheckpoint(workspaceRoot, conversationId, messageId)
    const restored = new Set(checkpoint.restoredPaths ?? [])
    return {
      ...toSummary(checkpoint),
      files: checkpoint.changes.map((change) => ({
        ...change,
        kind: changeKind(change),
        restored: restored.has(change.path),
        conflicted: restored.has(change.path) ? false : hasConflict(workspaceRoot, change)
      }))
    }
  }

  restore(
    workspaceRoot: string,
    conversationId: string,
    messageId: string,
    options: { paths?: string[]; force?: boolean } = {}
  ): RestoreCheckpointResult {
    const filePath = checkpointPath(workspaceRoot, conversationId, messageId)
    const checkpoint = this.requireCheckpoint(workspaceRoot, conversationId, messageId)
    const restoredPaths = new Set(checkpoint.restoredPaths ?? [])
    const requestedPaths = options.paths ?? checkpoint.changes.map((change) => change.path)
    const knownPaths = new Set(checkpoint.changes.map((change) => change.path))
    const unknownPath = requestedPaths.find((path) => !knownPaths.has(path))
    if (unknownPath) throw new Error(`File "${unknownPath}" is not part of this checkpoint.`)

    const selectedPaths = new Set(requestedPaths)
    const selectedChanges = checkpoint.changes.filter(
      (change) => selectedPaths.has(change.path) && !restoredPaths.has(change.path)
    )
    const conflicts = selectedChanges
      .filter((change) => hasConflict(workspaceRoot, change))
      .map((change) => change.path)
    if (conflicts.length > 0 && !options.force) {
      return { restoredFiles: [], conflicts, checkpoint: toSummary(checkpoint) }
    }

    const restoredFiles: string[] = []
    for (const change of selectedChanges) {
      const target = resolveInWorkspace(workspaceRoot, change.path)
      if (change.before === null) {
        rmSync(target, { force: true })
      } else {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, change.before, 'utf-8')
      }
      restoredFiles.push(change.path)
      restoredPaths.add(change.path)
    }

    const allRestored = checkpoint.changes.every((change) => restoredPaths.has(change.path))
    const restored: PersistedCheckpoint = {
      ...checkpoint,
      restoredAt: allRestored ? (checkpoint.restoredAt ?? Date.now()) : undefined,
      restoredPaths: [...restoredPaths]
    }
    writeJsonAtomic(filePath, restored)
    return { restoredFiles, conflicts: [], checkpoint: toSummary(restored) }
  }

  private requireCheckpoint(
    workspaceRoot: string,
    conversationId: string,
    messageId: string
  ): PersistedCheckpoint {
    const checkpoint = this.readFile(checkpointPath(workspaceRoot, conversationId, messageId))
    if (!checkpoint) throw new Error('No checkpoint was found for that message.')
    return checkpoint
  }

  private readFile(filePath: string): PersistedCheckpoint | null {
    if (!existsSync(filePath)) return null
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as PersistedCheckpoint
    const changes = Array.isArray(parsed.changes) ? parsed.changes.filter(isCheckpointChange) : []
    const restoredPaths = Array.isArray(parsed.restoredPaths)
      ? parsed.restoredPaths.filter((path): path is string => typeof path === 'string')
      : parsed.restoredAt
        ? changes.map((change) => change.path)
        : []
    return {
      conversationId: parsed.conversationId,
      messageId: parsed.messageId,
      createdAt: parsed.createdAt,
      restoredAt: parsed.restoredAt,
      restoredPaths,
      changes
    }
  }
}

function upsertChange(
  changes: CheckpointFileChange[],
  next: CheckpointFileChange
): CheckpointFileChange[] {
  const index = changes.findIndex((change) => change.path === next.path)
  if (index === -1) return [...changes, next]
  const original = changes[index]
  return [
    ...changes.slice(0, index),
    { path: next.path, before: original.before, after: next.after },
    ...changes.slice(index + 1)
  ]
}

function toSummary(checkpoint: PersistedCheckpoint): CheckpointSummary {
  return {
    conversationId: checkpoint.conversationId,
    messageId: checkpoint.messageId,
    changedFiles: checkpoint.changes.map((change) => change.path),
    restoredFiles: checkpoint.restoredPaths ?? [],
    restoredAt: checkpoint.restoredAt
  }
}

function changeKind(change: CheckpointFileChange): CheckpointFileChangeKind {
  if (change.before === null) return 'created'
  if (change.after === null) return 'deleted'
  return 'modified'
}

function hasConflict(workspaceRoot: string, change: CheckpointFileChange): boolean {
  const target = resolveInWorkspace(workspaceRoot, change.path)
  if (change.after === null) return existsSync(target)
  if (!existsSync(target)) return true
  return readFileSync(target, 'utf-8') !== change.after
}

function isCheckpointChange(value: unknown): value is CheckpointFileChange {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CheckpointFileChange>
  return (
    typeof candidate.path === 'string' &&
    (typeof candidate.before === 'string' || candidate.before === null) &&
    (typeof candidate.after === 'string' || candidate.after === null)
  )
}

export const checkpointStore = new CheckpointStore()
