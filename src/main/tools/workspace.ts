import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createLogger } from '../utils/logger'

const log = createLogger('workspace')

/** Hard cap on symlink hops followed by hand, so a link cycle cannot spin. */
const MAX_LINK_HOPS = 16

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

  const realTarget = realLocation(target)
  if (realTarget === null) {
    log.warn(`Could not resolve the real path of "${requested}" for symlink confinement.`)
    return
  }

  if (!isPathInside(realRoot, realTarget)) {
    throw new Error(`Path "${requested}" is outside the workspace and was blocked.`)
  }
}

/**
 * Where `path` really lands on disk, with every symlink in it followed.
 *
 * Confining the nearest *existing* part of the path is enough on its own: if
 * that resolves inside the workspace, so does everything nested under it, and
 * any link deeper down gets its own check when it is reached.
 *
 * The subtlety is what counts as existing. `realpathSync` cannot answer for a
 * link whose target does not exist yet — it throws `ENOENT` — and `existsSync`
 * follows the link and reports the same absence. Treating either as "no link is
 * involved" was an escape: a link inside the workspace pointing at a not-yet-
 * created file elsewhere passed the check, and writing to the path it returned
 * created that file outside the workspace. So `lstat` decides existence, and a
 * link that will not resolve is followed by hand instead of waved through.
 *
 * Returns null only when the location genuinely cannot be determined, which the
 * caller treats the same way it treats an unresolvable workspace root: warn, and
 * fall back to the lexical checks that have already run.
 */
function realLocation(path: string): string | null {
  let current = path
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    const entry = nearestExistingEntry(current)
    if (entry === null) return null
    try {
      return realpathSync.native(entry)
    } catch {
      // Only a dangling link reaches here — anything else resolved above.
      const followed = followLink(entry)
      if (followed === null) return null
      current = followed
    }
  }
  // A cycle, or a chain long enough to be indistinguishable from one.
  return null
}

/** Resolve one hop of a symlink against its own directory. */
function followLink(link: string): string | null {
  try {
    const target = readlinkSync(link)
    return isAbsolute(target) ? resolve(target) : resolve(dirname(link), target)
  } catch {
    return null
  }
}

/**
 * The deepest part of `path` that exists on disk, walking up until something
 * does. Uses `lstat` rather than `existsSync` so a symlink counts as existing
 * even when what it points at does not — see `realLocation` for why that
 * distinction is the whole point.
 */
function nearestExistingEntry(path: string): string | null {
  let current = path
  for (;;) {
    if (entryExists(current)) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
