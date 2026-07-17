import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkspaceTreeNode } from '@shared/workspaceFiles.types'
import type { ProjectMemory } from '@shared/projectMemory.types'
import { SKIP_DIRS } from '../tools/fileTools'
import { toWorkspaceRelative } from '../tools/workspace'
import { projectMemoryStore } from '../projects/ProjectMemoryStore'

const MAX_FILES = 500

/**
 * Checkpoint snapshots (`.anodex/checkpoints/<hash>/...`) are internal,
 * UUID-named blobs — never something a user browsing the Files panel wants
 * to see mixed in with their real project files (the Workspace Dock's
 * Checkpoints panel is the real UI for this data). The rest of `.anodex`
 * (skills, notes) stays visible; only this one subdirectory is excluded.
 */
const CHECKPOINTS_DIR = '.anodex/checkpoints'

/**
 * How much slack to give between a file's real mtime and the AI's recorded
 * write timestamp before treating a later mtime as a sign the user (not the
 * AI) touched it since. Generous, since the two clocks/timestamps aren't
 * perfectly aligned (tool-call time vs. filesystem write completion).
 */
const EDIT_ATTRIBUTION_TOLERANCE_MS = 5 * 60 * 1000

/** Shared across recursive calls so the cap applies to the whole tree, not per-folder. */
interface WalkBudget {
  filesRemaining: number
}

/**
 * List the active workspace as a real folder tree for the Files dock panel,
 * each file attributed to the user or the AI based on whether
 * `ProjectMemoryStore` recorded a write/move to that path at or after its
 * current on-disk modification time. Skips the same noise directories as the
 * AI's own `search_files` tool. Folders that end up with no visible children
 * (empty, or entirely filtered out) are omitted rather than shown as dead ends.
 */
export async function listWorkspaceFiles(
  root: string,
  projectId: string | null
): Promise<WorkspaceTreeNode[]> {
  const memory = projectId ? projectMemoryStore.get(projectId) : null
  return walk(root, root, memory, { filesRemaining: MAX_FILES })
}

async function walk(
  dir: string,
  root: string,
  memory: ProjectMemory | null,
  budget: WalkBudget
): Promise<WorkspaceTreeNode[]> {
  let dirEntries
  try {
    dirEntries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  // Folders before files, alphabetical within each group — the standard file-
  // explorer convention, and independent of the (path-string) sort the old
  // flat list used, which didn't actually group by directory.
  const sorted = [...dirEntries].sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const nodes: WorkspaceTreeNode[] = []

  for (const entry of sorted) {
    if (budget.filesRemaining <= 0) break
    const full = join(dir, entry.name)

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      const path = toWorkspaceRelative(root, full)
      if (path === CHECKPOINTS_DIR) continue
      const children = await walk(full, root, memory, budget)
      if (children.length === 0) continue
      nodes.push({
        type: 'folder',
        path,
        name: entry.name,
        children
      })
      continue
    }
    if (!entry.isFile()) continue

    try {
      const info = await stat(full)
      const path = toWorkspaceRelative(root, full)
      nodes.push({
        type: 'file',
        path,
        name: entry.name,
        sizeBytes: info.size,
        modifiedAt: info.mtimeMs,
        editedBy: determineEditedBy(path, info.mtimeMs, memory)
      })
      budget.filesRemaining--
    } catch {
      // Unreadable file — skip it rather than fail the whole listing.
    }
  }

  return nodes
}

/** Exported for unit testing. */
export function determineEditedBy(
  path: string,
  modifiedAt: number,
  memory: ProjectMemory | null
): 'user' | 'ai' {
  const touch = memory?.filesTouched.find((t) => t.path === path)
  const isEdit = touch && (touch.action === 'write' || touch.action === 'move')
  if (!isEdit) return 'user'
  return modifiedAt > touch.at + EDIT_ATTRIBUTION_TOLERANCE_MS ? 'user' : 'ai'
}
