import { existsSync, statfsSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Bytes free to this user on the disk holding `target`, measured at its nearest
 * existing folder (one that has not been created yet lives on the same disk as
 * its parent). Tries each fallback in turn; null when none can be measured.
 */
export function freeBytesAt(...targets: Array<string | undefined>): number | null {
  for (const candidate of targets) {
    if (!candidate) continue
    let dir = candidate
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir)
    try {
      const stats = statfsSync(dir)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch {
      // try the next place
    }
  }
  return null
}
