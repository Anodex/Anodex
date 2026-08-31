import { describe, expect, it } from 'vitest'
import { describeWorkingRoom } from '../workingRoom'
import { CONTEXT_SIZE_LADDER } from '../contextSizes'

describe('describeWorkingRoom', () => {
  // A context size is not working room. At 8,192 the output reserve, reference
  // context and tool schemas take most of it and about 4,750 tokens are left to
  // actually work in - roughly one file read. Nothing told the user that, and
  // it is the difference measured between a small model failing a task three
  // times and passing it.
  it('reports the room left after the fixed reserves', () => {
    const small = describeWorkingRoom(8192)
    const large = describeWorkingRoom(65536)

    expect(small.workingSet).toBeLessThan(5000)
    expect(large.workingSet).toBeGreaterThan(40000)
    expect(small.text).toContain('4,7')
  })

  it('says plainly that a small window is tight for multi-step work', () => {
    expect(describeWorkingRoom(8192).tight).toBe(true)
    expect(describeWorkingRoom(4096).tight).toBe(true)
  })

  // 16,384 is where a 4B stopped failing single-file work, so it must not be
  // labelled tight - the label has to mean something.
  it('does not call a workable window tight', () => {
    expect(describeWorkingRoom(16384).tight).toBe(false)
    expect(describeWorkingRoom(65536).tight).toBe(false)
  })

  it('describes every size the picker offers', () => {
    for (const size of CONTEXT_SIZE_LADDER) {
      const described = describeWorkingRoom(size)
      expect(described.workingSet).toBeGreaterThan(0)
      expect(described.text.length).toBeGreaterThan(0)
    }
  })
})
