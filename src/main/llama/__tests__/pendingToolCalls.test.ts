import { describe, expect, it } from 'vitest'
import { PendingToolCallTracker } from '../pendingToolCalls'

function chunk(callIndex: number, functionName: string, paramsChunk: string) {
  return { callIndex, functionName, paramsChunk }
}

describe('PendingToolCallTracker', () => {
  it('emits a provisional running card on the first params chunk of a write tool', () => {
    const tracker = new PendingToolCallTracker()
    const call = tracker.onParamsChunk(0, chunk(0, 'write_file', '{"pa'))
    expect(call).not.toBeNull()
    expect(call?.status).toBe('running')
    expect(call?.kind).toBe('write')
    expect(call?.name).toBe('write_file')
    expect(call?.title).toBe('Write ...')
  })

  it('re-emits once when the target path becomes parseable, then goes quiet', () => {
    const tracker = new PendingToolCallTracker()
    const first = tracker.onParamsChunk(0, chunk(0, 'edit_file', '{"pa'))
    expect(first?.title).toBe('Edit ...')

    expect(tracker.onParamsChunk(0, chunk(0, 'edit_file', 'th": "src/ma'))).toBeNull()

    const withPath = tracker.onParamsChunk(0, chunk(0, 'edit_file', 'in.ts", "oldText": "'))
    expect(withPath?.title).toBe('Edit src/main.ts')
    expect(withPath?.id).toBe(first?.id)

    expect(tracker.onParamsChunk(0, chunk(0, 'edit_file', 'lots more file content'))).toBeNull()
  })

  it('unescapes JSON escapes in the parsed path', () => {
    const tracker = new PendingToolCallTracker()
    tracker.onParamsChunk(0, chunk(0, 'write_file', '{'))
    const call = tracker.onParamsChunk(0, chunk(0, 'write_file', '"path": "docs\\\\a.md",'))
    expect(call?.title).toBe('Write docs\\a.md')
  })

  it('ignores tools that are not tracked', () => {
    const tracker = new PendingToolCallTracker()
    expect(tracker.onParamsChunk(0, chunk(0, 'read_file', '{"path": "a.ts"}'))).toBeNull()
    expect(tracker.claim('read_file')).toBeUndefined()
  })

  it('hands ids to claimants in generation order and stops sweeping claimed calls', () => {
    const tracker = new PendingToolCallTracker()
    const a = tracker.onParamsChunk(0, chunk(0, 'write_file', '{"path": "a.ts", '))
    const b = tracker.onParamsChunk(0, chunk(1, 'write_file', '{"path": "b.ts", '))

    expect(tracker.claim('write_file')).toBe(a?.id)
    expect(tracker.claim('write_file')).toBe(b?.id)
    expect(tracker.claim('write_file')).toBeUndefined()
    expect(tracker.sweep(0)).toHaveLength(0)
  })

  it('sweeps unclaimed calls of a round as interrupted errors, exactly once', () => {
    const tracker = new PendingToolCallTracker()
    const started = tracker.onParamsChunk(0, chunk(0, 'patch_file', '{"path": "c.ts", '))

    const swept = tracker.sweep(0)
    expect(swept).toHaveLength(1)
    expect(swept[0].id).toBe(started?.id)
    expect(swept[0].status).toBe('error')
    expect(swept[0].detail).toBe('Interrupted')
    expect(swept[0].title).toBe('Patch c.ts')

    expect(tracker.sweep(0)).toHaveLength(0)
    expect(tracker.claim('patch_file')).toBeUndefined()
  })

  it('sweepAll settles leftovers across rounds', () => {
    const tracker = new PendingToolCallTracker()
    tracker.onParamsChunk(0, chunk(0, 'write_file', '{"path": "a.ts", '))
    tracker.onParamsChunk(1, chunk(0, 'edit_file', '{"path": "b.ts", '))

    const swept = tracker.sweepAll()
    expect(swept).toHaveLength(2)
    expect(swept.every((call) => call.status === 'error')).toBe(true)
    expect(tracker.sweepAll()).toHaveLength(0)
  })
})
