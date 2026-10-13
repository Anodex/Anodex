import { describe, expect, it } from 'vitest'
import { prefixSnapshotCuts, readSteps, sharedPrefixLength } from '../prefixSnapshot'

/** `count` distinct tokens starting at `from`, standing in for a rendered prompt. */
function tokens(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => from + index)
}

describe('readSteps', () => {
  it('reads in pieces no longer than the piece size', () => {
    expect(readSteps(0, 600, [], 256)).toEqual([
      { end: 256, checkpoint: false },
      { end: 512, checkpoint: false },
      { end: 600, checkpoint: false }
    ])
  })

  it('ends a piece on every snapshot cut and checkpoints there', () => {
    expect(readSteps(0, 600, [300], 256)).toEqual([
      { end: 256, checkpoint: false },
      { end: 300, checkpoint: true },
      { end: 556, checkpoint: false },
      { end: 600, checkpoint: false }
    ])
  })

  it('skips cuts already read past, and starts where the sequence is', () => {
    // A new chat restored from the clock checkpoint: earlier cuts are behind it.
    expect(readSteps(1_581, 1_900, [1_581, 1_850], 256)).toEqual([
      { end: 1_837, checkpoint: false },
      { end: 1_850, checkpoint: true },
      { end: 1_900, checkpoint: false }
    ])
  })

  it('reads nothing when the sequence already holds the prompt', () => {
    expect(readSteps(900, 900, [500])).toEqual([])
  })
})

describe('sharedPrefixLength', () => {
  it('counts the leading tokens two renderings agree on', () => {
    expect(sharedPrefixLength([1, 2, 3, 4], [1, 2, 9, 4])).toBe(2)
  })

  it('stops at the shorter one when one is a prefix of the other', () => {
    expect(sharedPrefixLength([1, 2], [1, 2, 3])).toBe(2)
  })

  it('is zero when they differ from the first token', () => {
    expect(sharedPrefixLength([5], [6])).toBe(0)
  })
})

describe('prefixSnapshotCuts', () => {
  const system = tokens(0, 2_000)
  const toolDocs = tokens(10_000, 800)

  it('cuts where the tools begin and where the user message begins', () => {
    // The two cuts a new chat on a hybrid model can restore from: the plain
    // system prompt (reusable when the next chat routes other tools) and the
    // whole shared prefix (reusable when it routes the same ones).
    const cuts = prefixSnapshotCuts({
      withoutTools: [...system, 1, 99_001],
      withTools: [...system, ...toolDocs, 1, 99_001],
      withToolsOtherProbe: [...system, ...toolDocs, 1, 99_002]
    })
    expect(cuts).toEqual([2_000 - 4, 2_801 - 4])
  })

  it('cuts before the clock, the first thing two conversations disagree on', () => {
    // Qwen3.6 with Anodex's prompt: the clock ~1,600 tokens in, the tools
    // ~1,900, the user message ~2,900. Without the first cut a chat started a
    // minute later shares nothing restorable with this one.
    const beforeClock = tokens(0, 1_600)
    const clock = [77_001, 77_002]
    const afterClock = tokens(2_000, 300)
    const head = [...beforeClock, ...clock, ...afterClock]
    const cuts = prefixSnapshotCuts({
      withTools: [...head, ...toolDocs, 1, 99_001],
      withoutTools: [...head, 1, 99_001],
      withToolsOtherProbe: [...head, ...toolDocs, 1, 99_002],
      withClockMasked: [...beforeClock, 88_000, ...afterClock, ...toolDocs, 1, 99_001]
    })
    expect(cuts).toEqual([1_600 - 4, head.length - 4, head.length + 801 - 4])
  })

  it('keeps clear of the boundary a real message could merge into', () => {
    const [cut] = prefixSnapshotCuts({
      withoutTools: [...system, 99_001],
      withTools: [...system, 99_001],
      withToolsOtherProbe: [...system, 99_002]
    })
    expect(cut).toBeLessThan(system.length)
  })

  it('takes one snapshot when the two cuts are almost the same place', () => {
    // A small tool section: a second checkpoint would cost the same memory for
    // a few dozen tokens of reading.
    const cuts = prefixSnapshotCuts({
      withoutTools: [...system, 99_001],
      withTools: [...system, ...tokens(10_000, 40), 99_001],
      withToolsOtherProbe: [...system, ...tokens(10_000, 40), 99_002]
    })
    expect(cuts).toEqual([2_040 - 4])
  })

  it('takes none for a prompt too short to be worth the memory', () => {
    const short = tokens(0, 100)
    expect(
      prefixSnapshotCuts({
        withoutTools: [...short, 99_001],
        withTools: [...short, 99_001],
        withToolsOtherProbe: [...short, 99_002]
      })
    ).toEqual([])
  })
})
