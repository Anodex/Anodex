import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Resolve a user/AI-supplied path against the workspace root and guarantee it
 * stays inside it. This is the core safety boundary for every file tool — a
 * path that escapes the workspace (via `..` or an absolute path elsewhere)
 * throws instead of touching the filesystem.
 */
export function resolveInWorkspace(root: string, requested: string): string {
  const target = isAbsolute(requested) ? resolve(requested) : resolve(root, requested)
  const rel = relative(root, target)
  const escapes = rel.startsWith('..') || isAbsolute(rel)
  if (escapes) {
    throw new Error(`Path "${requested}" is outside the workspace and was blocked.`)
  }
  return target
}

/** Present an absolute path as a clean, forward-slashed workspace-relative path. */
export function toWorkspaceRelative(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath)
  return rel === '' ? '.' : rel.split(sep).join('/')
}
