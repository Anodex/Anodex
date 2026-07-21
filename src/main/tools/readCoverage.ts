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
