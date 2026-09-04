import { randomUUID } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'

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
    renameWithRetry(tmpPath, filePath)
  } catch (error) {
    // Without this a failed write leaves a temp file next to the real store,
    // accumulating one per failure and looking like a backup worth restoring.
    rmSync(tmpPath, { force: true })
    throw error
  }
}

/**
 * Windows fails a rename onto a file that any process currently has open, and
 * reports it as `EPERM` (sometimes `EACCES` or `EBUSY`) rather than as the
 * sharing conflict it is. Antivirus scanners, Windows Search, backup agents
 * and anything reading the store all hold a handle for a few milliseconds at a
 * time, so this is ordinary background noise on Windows rather than an
 * exceptional condition — and it clears on its own.
 *
 * Two measured Critical Thinking runs died on it: `EPERM ... rename
 * runs.json.<pid>.tmp`, once at step 5 of 7 after five minutes of research,
 * with a single failed rename discarding the whole run. On POSIX the same
 * codes mean something durable, and a handful of retries costs a few
 * milliseconds before the error surfaces exactly as it does today.
 *
 * Deliberately small, and the synchronous path is why. `writeTextAtomic` backs
 * conversations, checkpoints, agent runs, the code index and the change
 * library, and it blocks the Electron main process while it waits -- so the
 * whole budget is under a fifth of a second. That stall is only ever paid on a
 * lock that is already failing, and the alternative is losing the write, but it
 * has to stay small enough that a genuinely locked file fails quickly and
 * visibly rather than freezing the app.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80]

export function isTransientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && TRANSIENT_RENAME_CODES.has(code)
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !isTransientRenameError(error)) throw error
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

/**
 * Block for `ms` without a timer. This path is already synchronous — every
 * caller is mid-`writeFileSync` — so there is no event loop to yield to, and
 * `Atomics.wait` is the one way to pause without spinning the CPU.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * The same guarantee, without blocking the main process.
 *
 * `CriticalThinkingStore` and `CriticalThinkingEvidenceStore` write from a
 * queue while a run is in flight, and each had its own copy of temp-write-then-
 * rename with no retry. That is where both observed `EPERM` failures landed, so
 * the retry has to live on this path rather than only on the synchronous one.
 */
export async function writeTextAtomicAsync(filePath: string, contents: string): Promise<void> {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tmpPath, contents, 'utf-8')
    await renameWithRetryAsync(tmpPath, filePath)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/** JSON convenience over {@link writeTextAtomicAsync}. */
export async function writeJsonAtomicAsync(filePath: string, data: unknown): Promise<void> {
  await writeTextAtomicAsync(filePath, JSON.stringify(data, null, 2))
}

async function renameWithRetryAsync(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !isTransientRenameError(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]))
    }
  }
}
