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

  describe('noteMutation / hasInteracted', () => {
    it('clears full-file coverage so an edited file can be re-read', () => {
      const tracker = new ReadCoverageTracker()
      tracker.recordFullFile('a.ts')
      tracker.noteMutation('a.ts')
      expect(tracker.isFullyCovered('a.ts')).toBe(false)
      expect(tracker.uncovered('a.ts', 1, 200)).toEqual([{ start: 1, end: 200 }])
    })

    it('clears range coverage so an edited region can be re-read', () => {
      const tracker = new ReadCoverageTracker()
      tracker.recordRange('a.ts', 1, 200)
      tracker.noteMutation('a.ts')
      expect(tracker.uncovered('a.ts', 40, 60)).toEqual([{ start: 40, end: 60 }])
    })

    it('resets the same-file read-attempt counter — a mutation restarts interest', () => {
      const tracker = new ReadCoverageTracker()
      for (let i = 0; i < 7; i++) tracker.recordReadAttempt('a.ts')
      tracker.noteMutation('a.ts')
      expect(tracker.recordReadAttempt('a.ts')).toBe(1)
    })

    it('leaves unrelated paths untouched', () => {
      const tracker = new ReadCoverageTracker()
      tracker.recordFullFile('a.ts')
      tracker.recordRange('b.ts', 1, 50)
      tracker.noteMutation('a.ts')
      expect(tracker.hasAnyCoverage('b.ts')).toBe(true)
      expect(tracker.isFullyCovered('a.ts')).toBe(false)
    })

    it('hasInteracted is true for a mutated path with no read coverage (e.g. a deleted file)', () => {
      const tracker = new ReadCoverageTracker()
      tracker.noteMutation('gone.ts')
      expect(tracker.hasAnyCoverage('gone.ts')).toBe(false)
      expect(tracker.hasInteracted('gone.ts')).toBe(true)
    })

    it('hasInteracted is true for a read path and false for an untouched one', () => {
      const tracker = new ReadCoverageTracker()
      tracker.recordRange('a.ts', 1, 10)
      expect(tracker.hasInteracted('a.ts')).toBe(true)
      expect(tracker.hasInteracted('b.ts')).toBe(false)
    })
  })

  describe('reconcileMtime', () => {
    it('stores the first observed mtime without touching coverage', () => {
      const tracker = new ReadCoverageTracker()
      tracker.recordRange('a.ts', 1, 100)
      tracker.reconcileMtime('a.ts', 1_000)
      expect(tracker.uncovered('a.ts', 1, 100)).toEqual([])
    })

    it('keeps coverage while the mtime stays the same', () => {
      const tracker = new ReadCoverageTracker()
      tracker.reconcileMtime('a.ts', 1_000)
      tracker.recordFullFile('a.ts')
      tracker.reconcileMtime('a.ts', 1_000)
      expect(tracker.isFullyCovered('a.ts')).toBe(true)
    })

    it('drops coverage and the attempt counter once the mtime changes', () => {
      const tracker = new ReadCoverageTracker()
      tracker.reconcileMtime('a.ts', 1_000)
      tracker.recordRange('a.ts', 1, 200)
      for (let i = 0; i < 7; i++) tracker.recordReadAttempt('a.ts')

      tracker.reconcileMtime('a.ts', 2_000)

      expect(tracker.uncovered('a.ts', 1, 200)).toEqual([{ start: 1, end: 200 }])
      expect(tracker.recordReadAttempt('a.ts')).toBe(1)
    })

    it('still reports hasInteracted for a read whose coverage was dropped as stale', () => {
      // The final-reply path-claim check must not accuse the model of never
      // reading a file it genuinely read, just because the file changed on
      // disk afterward and the stale coverage was reconciled away.
      const tracker = new ReadCoverageTracker()
      tracker.reconcileMtime('a.ts', 1_000)
      tracker.recordFullFile('a.ts')
      tracker.reconcileMtime('a.ts', 2_000)

      expect(tracker.hasAnyCoverage('a.ts')).toBe(false)
      expect(tracker.hasInteracted('a.ts')).toBe(true)
    })

    it('does not mark hasInteracted when the changed file never had coverage', () => {
      const tracker = new ReadCoverageTracker()
      tracker.reconcileMtime('a.ts', 1_000)
      tracker.reconcileMtime('a.ts', 2_000)
      expect(tracker.hasInteracted('a.ts')).toBe(false)
    })

    it('treats the first mtime after noteMutation as a fresh observation', () => {
      const tracker = new ReadCoverageTracker()
      tracker.reconcileMtime('a.ts', 1_000)
      tracker.recordFullFile('a.ts')
      tracker.noteMutation('a.ts')
      // The post-write read observes a new mtime; no coverage exists to drop
      // and recording afterward must stick.
      tracker.reconcileMtime('a.ts', 2_000)
      tracker.recordFullFile('a.ts')
      expect(tracker.isFullyCovered('a.ts')).toBe(true)
    })
  })

  describe('recordReadAttempt', () => {
    it('starts at 1 for the first attempt and increments per call', () => {
      const tracker = new ReadCoverageTracker()
      expect(tracker.recordReadAttempt('a.ts')).toBe(1)
      expect(tracker.recordReadAttempt('a.ts')).toBe(2)
      expect(tracker.recordReadAttempt('a.ts')).toBe(3)
    })

    it('keeps attempt counts independent per path', () => {
      const tracker = new ReadCoverageTracker()
      tracker.recordReadAttempt('a.ts')
      tracker.recordReadAttempt('a.ts')
      tracker.recordReadAttempt('b.ts')

      expect(tracker.recordReadAttempt('a.ts')).toBe(3)
      expect(tracker.recordReadAttempt('b.ts')).toBe(2)
    })
  })
})
