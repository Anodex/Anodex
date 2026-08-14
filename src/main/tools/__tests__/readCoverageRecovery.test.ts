import { describe, expect, it } from 'vitest'
import { createReadCoverageTracker } from '../readCoverage'

/**
 * A context epoch drops evidence out of the model's active context while the
 * tracker — which spans the whole bounded reply — still records it as read. The
 * allowance exists so the handoff's own "reopen exact detail" instruction is
 * followable; the bounds exist so it does not reopen the read churn the tracker
 * was built to stop.
 */
describe('ReadCoverageTracker context-epoch recovery', () => {
  it('serves a file again once after an epoch, then goes back to deduplicating', () => {
    const coverage = createReadCoverageTracker()
    coverage.recordFullFile('/w/a.ts')
    expect(coverage.isFullyCovered('/w/a.ts')).toBe(true)
    // Before an epoch there is no allowance at all.
    expect(coverage.claimRecoveryRead('/w/a.ts')).toBe(false)

    coverage.beginRecoveryEpoch(3)
    expect(coverage.claimRecoveryRead('/w/a.ts')).toBe(true)
    expect(coverage.isFullyCovered('/w/a.ts')).toBe(false)

    // The re-read restores coverage; a second claim for the same file must not
    // drop it again, or one file could be re-served indefinitely.
    coverage.recordFullFile('/w/a.ts')
    expect(coverage.claimRecoveryRead('/w/a.ts')).toBe(false)
    expect(coverage.isFullyCovered('/w/a.ts')).toBe(true)
  })

  it('spends at most the granted allowance across distinct files', () => {
    const coverage = createReadCoverageTracker()
    for (const path of ['/w/a.ts', '/w/b.ts', '/w/c.ts']) coverage.recordFullFile(path)
    coverage.beginRecoveryEpoch(2)

    expect(coverage.claimRecoveryRead('/w/a.ts')).toBe(true)
    expect(coverage.claimRecoveryRead('/w/b.ts')).toBe(true)
    expect(coverage.claimRecoveryRead('/w/c.ts')).toBe(false)
    expect(coverage.recoveryReadsLeft).toBe(0)
    expect(coverage.isFullyCovered('/w/c.ts')).toBe(true)
  })

  it('reopens a covered line range rather than refusing it', () => {
    const coverage = createReadCoverageTracker()
    coverage.recordRange('/w/a.ts', 1, 200)
    expect(coverage.uncovered('/w/a.ts', 1, 200)).toEqual([])

    coverage.beginRecoveryEpoch(1)
    expect(coverage.claimRecoveryRead('/w/a.ts')).toBe(true)
    expect(coverage.uncovered('/w/a.ts', 1, 200)).toEqual([{ start: 1, end: 200 }])
  })

  it('never grants a recovery read for a file this task never read', () => {
    const coverage = createReadCoverageTracker()
    coverage.beginRecoveryEpoch(3)
    expect(coverage.claimRecoveryRead('/w/never.ts')).toBe(false)
    expect(coverage.recoveryReadsLeft).toBe(3)
  })

  it('clears the refusal ladder so the first recovery read is not punished', () => {
    const coverage = createReadCoverageTracker()
    coverage.recordCoverageRefusal()
    coverage.recordCoverageRefusal()
    coverage.beginRecoveryEpoch(2)
    expect(coverage.recordCoverageRefusal()).toBe(1)
  })
})
