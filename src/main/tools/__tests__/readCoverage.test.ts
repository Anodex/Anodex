import { describe, expect, it } from 'vitest'
import { ReadCoverageTracker } from '../readCoverage'

describe('ReadCoverageTracker', () => {
  it('reports the whole range as uncovered before anything is recorded', () => {
    const tracker = new ReadCoverageTracker()
    expect(tracker.uncovered('a.ts', 1, 200)).toEqual([{ start: 1, end: 200 }])
  })

  it('reports nothing uncovered once the exact same range is recorded', () => {
    const tracker = new ReadCoverageTracker()
    tracker.recordRange('a.ts', 1, 200)
    expect(tracker.uncovered('a.ts', 1, 200)).toEqual([])
  })

  it('reports nothing uncovered for a subset of an already-covered range', () => {
    const tracker = new ReadCoverageTracker()
    tracker.recordRange('a.ts', 1, 200)
    // The exact live-retest scenario: 1-150, then 1-200, then 35-200, etc.
    expect(tracker.uncovered('a.ts', 1, 150)).toEqual([])
    expect(tracker.uncovered('a.ts', 35, 200)).toEqual([])
    expect(tracker.uncovered('a.ts', 79, 250)).toEqual([{ start: 201, end: 250 }])
  })

  it('serves only the trailing new portion when a request extends past covered territory', () => {
    const tracker = new ReadCoverageTracker()
    tracker.recordRange('a.ts', 1, 200)
    expect(tracker.uncovered('a.ts', 150, 400)).toEqual([{ start: 201, end: 400 }])
  })

  it('serves only the leading new portion when a request starts before covered territory', () => {
    const tracker = new ReadCoverageTracker()
    tracker.recordRange('a.ts', 200, 400)
    expect(tracker.uncovered('a.ts', 1, 250)).toEqual([{ start: 1, end: 199 }])
  })

  it('splits into two gaps when a request straddles a single covered island', () => {
    const tracker = new ReadCoverageTracker()
    tracker.recordRange('a.ts', 100, 200)
    expect(tracker.uncovered('a.ts', 1, 300)).toEqual([
      { start: 1, end: 99 },
      { start: 201, end: 300 }
    ])
  })

  it('merges overlapping and adjacent ranges recorded separately', () => {
    const tracker = new ReadCoverageTracker()
    tracker.recordRange('a.ts', 1, 150)
    tracker.recordRange('a.ts', 140, 200)
    tracker.recordRange('a.ts', 201, 250)
    expect(tracker.uncovered('a.ts', 1, 250)).toEqual([])
    expect(tracker.uncovered('a.ts', 1, 300)).toEqual([{ start: 251, end: 300 }])
  })

  it('keeps coverage independent per file path', () => {
    const tracker = new ReadCoverageTracker()
    tracker.recordRange('a.ts', 1, 200)
    expect(tracker.uncovered('b.ts', 1, 200)).toEqual([{ start: 1, end: 200 }])
  })

  it('treats a full-file read as covering every future range request', () => {
    const tracker = new ReadCoverageTracker()
    tracker.recordFullFile('a.ts')
    expect(tracker.isFullyCovered('a.ts')).toBe(true)
    expect(tracker.uncovered('a.ts', 1, 9_999)).toEqual([])
  })

  it('ignores further range recordings once a file is marked fully covered', () => {
    const tracker = new ReadCoverageTracker()
    tracker.recordFullFile('a.ts')
    tracker.recordRange('a.ts', 1, 50)
    expect(tracker.uncovered('a.ts', 1, 9_999)).toEqual([])
  })

  describe('hasAnyCoverage', () => {
    it('is false for a path nothing has touched', () => {
      const tracker = new ReadCoverageTracker()
      expect(tracker.hasAnyCoverage('a.ts')).toBe(false)
    })

    it('is true after even a single small range read', () => {
      const tracker = new ReadCoverageTracker()
      tracker.recordRange('a.ts', 5, 10)
      expect(tracker.hasAnyCoverage('a.ts')).toBe(true)
    })

    it('is true after a full-file read', () => {
      const tracker = new ReadCoverageTracker()
      tracker.recordFullFile('a.ts')
      expect(tracker.hasAnyCoverage('a.ts')).toBe(true)
    })

    it('stays false for an unrelated path', () => {
      const tracker = new ReadCoverageTracker()
      tracker.recordRange('a.ts', 1, 200)
      expect(tracker.hasAnyCoverage('b.ts')).toBe(false)
    })
  })
})
