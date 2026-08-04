import { readFile } from 'node:fs/promises'

/**
 * Refuse to apply a write whose target is no longer what the approval prompt
 * described.
 *
 * Tools built on `runGuardedToolWithPrepare` read the destination during
 * `prepare()` — before the user is asked — and then write during `run()`,
 * after they answer. Everything in between is someone else's: the user's own
 * editor, a `run_command` build step, another agent. Two things go wrong if
 * that gap is not checked. The person approved a diff, or a "this replaces an
 * existing file" line, computed against content that no longer exists; and the
 * checkpoint records that stale content as `before`, so undoing the write
 * restores a version of the file that was never actually there.
 *
 * `expected` is the buffer read during prepare, or `null` if the path did not
 * exist then — so a file appearing underneath a create is caught as squarely
 * as a file changing underneath an overwrite.
 */
export async function assertFileStateUnchanged(
  path: string,
  expected: Buffer | null,
  action: string
): Promise<void> {
  const current = await readFile(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (
    (expected === null && current !== null) ||
    (expected !== null && (current === null || !current.equals(expected)))
  ) {
    throw new Error(`The file changed since this ${action} was proposed; read it again and retry.`)
  }
}
