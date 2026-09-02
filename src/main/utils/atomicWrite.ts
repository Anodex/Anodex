import { randomUUID } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * Write JSON to `filePath` atomically: serialize to a sibling temp file, then
 * rename it over the real path. A crash or power loss mid-write leaves
 * either the old file fully intact or the new one fully written — never a
 * truncated/half-written file, which `JSON.parse` would otherwise choke on
 * the next time a store loads it. `renameSync` overwriting an existing
 * destination is atomic and supported on both POSIX and Windows.
 *
 * The caller is responsible for ensuring `filePath`'s parent directory
 * already exists.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  // Serialised before the temp file exists, so a value that cannot be
  // stringified fails without ever opening a handle beside the target.
  writeTextAtomic(filePath, JSON.stringify(data, null, 2))
}

/**
 * The same guarantee for a file that is not JSON — see {@link writeJsonAtomic}.
 *
 * `changeLibrary` writes proposals in its own markdown-ish format and needs the
 * atomicity just as much: it writes the archive and then deletes the original,
 * so a truncated write there loses the proposal rather than damaging a copy.
 */
export function writeTextAtomic(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmpPath, contents, 'utf-8')
    renameSync(tmpPath, filePath)
  } catch (error) {
    // Without this a failed write leaves a temp file next to the real store,
    // accumulating one per failure and looking like a backup worth restoring.
    rmSync(tmpPath, { force: true })
    throw error
  }
}
