/** A 1-indexed, inclusive line range. */
export interface LineRange {
  start: number
  end: number
}

/**
 * Tracks which line ranges of which files have already been read within one
 * bounded task (a whole `runBoundedChatGeneration` reply spanning several
 * continuation cycles, or a whole Agent run spanning several turns) — see
 * `docs/CONTEXT_ADAPTIVE_RUNTIME_RECOVERY_HANDOFF.md`, Phase 5.
 *
 * A live retest of the exact 8K project-chat audit reread the opening ~250
 * lines of the same file across FIVE overlapping `read_file_range` calls
 * (`1-150`, `1-200` twice, `35-200`, `39-200`, `40-200`, `56-200`, `79-250`)
 * spread across different continuation cycles, spending tool-call and
 * output-token budget re-covering territory instead of reaching the
 * requested 12+ distinct files. Root cause: a mid-turn compaction folds an
 * older cycle's exchange into a natural-language summary that doesn't
 * preserve exact "already-read line X to Y" facts, so the model — no longer
 * sure exactly what it saw — re-reads defensively. This tracker is the
 * deterministic backstop: independent of whether the model correctly
 * remembers, a request for already-covered territory is trimmed down to
 * (or entirely replaced by a pointer, if nothing is left) only what's
 * genuinely new, at the tool layer, every time.
 *
 * Keyed by the caller's own path string — callers are expected to key by
 * the same normalized (typically absolute, workspace-resolved) form used
 * for a real read, so `./x.ts`, `x.ts`, and an absolute path to the same
 * file don't accidentally track as different files.
 */
export class ReadCoverageTracker {
  private ranges = new Map<string, LineRange[]>()
  private fullFiles = new Set<string>()
  private readAttempts = new Map<string, number>()
  private mutatedPaths = new Set<string>()
  private observedMtimes = new Map<string, number>()
  private invalidatedReads = new Set<string>()
  private coverageRefusals = 0

  /**
   * Record that `path` was successfully written, deleted, or moved this task
   * — which makes any read coverage recorded for it stale. Without this, a
   * read → edit → re-read sequence inside one bounded task is told "already
   * read earlier this task" and served nothing, so the model can never see
   * (or verify) its own edit's result and keeps operating on pre-edit
   * content — the exact `edit_file`/"text not found" failure mode the
   * runtime budget work exists to eliminate. Clearing `readAttempts` too is
   * deliberate: a mutation legitimately restarts interest in a file, and the
   * pathological page-through-one-huge-file case this cap exists for
   * involves no writes at all, so resetting on write reopens nothing.
   */
  noteMutation(path: string): void {
    this.mutatedPaths.add(path)
    this.fullFiles.delete(path)
    this.ranges.delete(path)
    this.readAttempts.delete(path)
    // Real work happened, so the model is no longer stuck in the read loop the
    // refusal escalation exists to break. See `recordCoverageRefusal`.
    this.coverageRefusals = 0
    // The next read observes the post-write mtime as a fresh first sighting
    // instead of comparing it against the pre-write one already stored.
    this.observedMtimes.delete(path)
  }

  /**
   * Reconcile coverage with the file's currently-observed mtime BEFORE
   * trusting or extending it — the catch-all for changes our own write
   * tools' `noteMutation` cannot see: a `run_command` side effect (a
   * formatter, codegen, git checkout), or the user editing the file in
   * their own editor mid-task. If the file changed since its coverage was
   * recorded, that coverage describes content that no longer exists, so it
   * is dropped (attempt counter included, same reasoning as `noteMutation`)
   * and the read proceeds as genuinely new. Read tools call this right
   * after `stat`, before consulting `isFullyCovered`/`uncovered`; recording
   * in the same call is then keyed to the mtime just observed.
   */
  reconcileMtime(path: string, mtimeMs: number): void {
    const known = this.observedMtimes.get(path)
    if (known !== undefined && known !== mtimeMs) this.dropCoverage(path)
    this.observedMtimes.set(path, mtimeMs)
  }

  /**
   * Forget what was read of `path`, so the next read serves real content again.
   *
   * Shared by mtime reconciliation and the context-epoch recovery allowance
   * below, because both describe the same situation: the coverage on record no
   * longer corresponds to anything the model can currently see.
   */
  private dropCoverage(path: string): void {
    // Remember that this task DID read (an earlier version of) the file —
    // dropping coverage must not turn an honest mention of it in the final
    // reply into a "never read this task" accusation (see `hasInteracted`).
    if (this.fullFiles.has(path) || (this.ranges.get(path)?.length ?? 0) > 0) {
      this.invalidatedReads.add(path)
    }
    this.fullFiles.delete(path)
    this.ranges.delete(path)
    this.readAttempts.delete(path)
  }

  /**
   * Whether this task genuinely interacted with `path` at all — read any part
   * of it (including an earlier version since changed on disk, see
   * `reconcileMtime`), or successfully mutated (wrote/deleted/moved) it.
   * Broader than `hasAnyCoverage`: a reply saying "I deleted `x/y.ts`" is
   * describing a real, verified action even though the path no longer exists
   * on disk and has no read coverage — see `findUnverifiedPathClaims`.
   */
  hasInteracted(path: string): boolean {
    return (
      this.hasAnyCoverage(path) || this.mutatedPaths.has(path) || this.invalidatedReads.has(path)
    )
  }

  /** Record that `path` has now been read in its entirety. */
  recordFullFile(path: string): void {
    this.fullFiles.add(path)
    this.ranges.delete(path)
  }

  /** Whether `path` has already been read in full. */
  isFullyCovered(path: string): boolean {
    return this.fullFiles.has(path)
  }

  /** Record that lines `start`-`end` (inclusive) of `path` have been read. */
  recordRange(path: string, start: number, end: number): void {
    if (this.fullFiles.has(path)) return
    const existing = this.ranges.get(path) ?? []
    this.ranges.set(path, mergeRanges([...existing, { start, end }]))
  }

  /**
   * The portions of `[start, end]` not yet covered for `path`, in ascending
   * order, clipped to the requested range. An empty array means the entire
   * requested range is already covered — nothing new to read.
   */
  uncovered(path: string, start: number, end: number): LineRange[] {
    if (this.fullFiles.has(path)) return []
    const covered = this.ranges.get(path) ?? []
    let gaps: LineRange[] = [{ start, end }]
    for (const range of covered) {
      gaps = gaps.flatMap((gap) => subtractRange(gap, range))
    }
    return gaps
  }

  /**
   * Whether any part of `path` — even a single line — has actually been read
   * this task, in full or by range. Used to check a claim in the model's own
   * final reply against what real tool calls actually touched (see
   * `findUnverifiedPathClaims` in `pathClaimVerification.ts`), as distinct
   * from `isFullyCovered`, which only answers "read in its entirety."
   */
  hasAnyCoverage(path: string): boolean {
    return this.fullFiles.has(path) || (this.ranges.get(path)?.length ?? 0) > 0
  }

  /**
   * Record one more genuinely-new `read_file_range` attempt against `path`
   * this task, returning the new total count — see `MAX_SAME_FILE_READS`'s
   * doc comment in `fileTools.ts` for why this exists as a separate counter
   * from line coverage: a live retest read a single 2,352-line file across
   * 15+ consecutive calls, methodically paging start to end, never moving on
   * to any of the other 11+ files the task needed. Coverage tracking alone
   * can't catch this — every one of those calls genuinely requested new,
   * not-yet-covered lines, so none of them were short-circuited by
   * `uncovered()`. This counts attempts on one file regardless of which
   * lines, so a caller can cap total depth on any single file independent
   * of how large it is.
   */
  recordReadAttempt(path: string): number {
    const count = (this.readAttempts.get(path) ?? 0) + 1
    this.readAttempts.set(path, count)
    return count
  }

  /**
   * Record one more read request that asked for territory already covered,
   * returning the running total for this task. Counted across all files, not
   * per file, because what this measures is the model ignoring coverage
   * feedback rather than any one file being over-read.
   *
   * Exists because the refusal used to be uniformly worded, always returned a
   * `success` status, and cost nothing to ignore — so in the driving incident
   * it was ignored **eleven consecutive times** while the model re-requested
   * ranges it had already been served. Escalating the response is what turns
   * "please stop" into something with consequences; see
   * `coverageRefusalResponse` in `fileTools.ts` for the ladder. Reset by
   * `noteMutation`, since doing real work legitimately reopens interest.
   */
  recordCoverageRefusal(): number {
    this.coverageRefusals++
    return this.coverageRefusals
  }
}

export function createReadCoverageTracker(): ReadCoverageTracker {
  return new ReadCoverageTracker()
}

/** Merge overlapping or adjacent (within 1 line) ranges into a minimal sorted set. */
function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const merged: LineRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/** `gap` minus `covered`: zero, one, or two remaining sub-ranges. */
function subtractRange(gap: LineRange, covered: LineRange): LineRange[] {
  if (covered.end < gap.start || covered.start > gap.end) return [gap]
  const result: LineRange[] = []
  if (covered.start > gap.start) result.push({ start: gap.start, end: covered.start - 1 })
  if (covered.end < gap.end) result.push({ start: covered.end + 1, end: gap.end })
  return result
}
