import { randomUUID } from 'node:crypto'
import { renameSync, writeFileSync } from 'node:fs'

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
  const tmpPath = `${filePath}.${randomUUID()}.tmp`
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmpPath, filePath)
}
