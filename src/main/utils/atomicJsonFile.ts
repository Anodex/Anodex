import { renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * Write JSON so a failure cannot destroy what was already there.
 *
 * A store that writes straight onto its own file can destroy itself.
 * `AgentRunStore.persist` called `writeFileSync` directly on `runs.json`, and a
 * crash, a full disk or a kill part-way through leaves that file truncated —
 * whereupon `loadRuns` catches the parse failure, logs "starting fresh", and
 * returns an empty list. A partial write loses every run on record, silently.
 *
 * Writing to a sibling temp file and renaming avoids that: a rename within a
 * directory is atomic, so a reader sees either the whole old file or the whole
 * new one. `CriticalThinkingStore` already did this; the agent store did not.
 *
 * Not hypothetical — a real `EPERM` on exactly this rename was observed in the
 * Critical Thinking store on 2026-08-28, twice in four minutes, from a
 * transient Windows lock. It retried and the run completed clean.
 *
 * Failures are thrown rather than swallowed: what a lost write means is the
 * caller's decision, and hiding it here would take that choice away.
 */
export function writeJsonFileAtomic(filePath: string, data: unknown): void {
  // Serialise first. A value that cannot be stringified must fail before the
  // temp file exists, so a bad write never even opens a handle near the target.
  writeTextFileAtomic(filePath, JSON.stringify(data, null, 2))
}

/** The same guarantee for a file that is not JSON — see {@link writeJsonFileAtomic}. */
export function writeTextFileAtomic(filePath: string, contents: string): void {
  // Process id in the name so two Anodex instances writing the same store
  // cannot rename each other's half-written file into place.
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  try {
    writeFileSync(temporaryPath, contents, 'utf-8')
    renameSync(temporaryPath, filePath)
  } catch (error) {
    // A temp file left behind would accumulate one per failure and, worse,
    // sit next to the real store looking like a backup worth restoring.
    rmSync(temporaryPath, { force: true })
    throw error
  }
}
