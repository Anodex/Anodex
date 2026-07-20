import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createLogger } from '../utils/logger'

const log = createLogger('workspace')

/**
 * Resolve a user/AI-supplied path against the workspace root and guarantee it
 * stays inside it. This is the core safety boundary for every file tool — a
 * path that escapes the workspace (via `..` or an absolute path elsewhere)
 * throws instead of touching the filesystem.
 */
export function resolveInWorkspace(root: string, requested: string): string {
  const target = isAbsolute(requested) ? resolve(requested) : resolve(root, requested)
  if (!isPathInside(root, target)) {
    throw new Error(`Path "${requested}" is outside the workspace and was blocked.`)
  }
  assertRealPathInside(root, target, requested)
  return target
}

/** Present an absolute path as a clean, forward-slashed workspace-relative path. */
export function toWorkspaceRelative(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath)
  return rel === '' ? '.' : rel.split(sep).join('/')
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * The lexical check above blocks `..` and absolute-path escapes, but a
 * symlink/junction inside the workspace can still point elsewhere. Resolve
 * the real workspace and the target's nearest existing ancestor so existing
 * links are confined while brand-new nested files can still be created.
 */
function assertRealPathInside(root: string, target: string, requested: string): void {
  let realRoot: string
  try {
    realRoot = realpathSync.native(root)
  } catch (error) {
    log.warn(
      `Could not resolve the real workspace root path — symlink confinement checks are ` +
        `disabled for this session (lexical ".."/absolute-path checks still apply):`,
      error
    )
    return
  }

  const existing = nearestExistingAncestor(target)
  if (!existing) return

  let realExisting: string
  try {
    realExisting = realpathSync.native(existing)
  } catch (error) {
    log.warn(`Could not resolve the real path of "${requested}" for symlink confinement:`, error)
    return
  }

  if (!isPathInside(realRoot, realExisting)) {
    throw new Error(`Path "${requested}" is outside the workspace and was blocked.`)
  }
}

function nearestExistingAncestor(path: string): string | null {
  let current = path
  for (;;) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}
