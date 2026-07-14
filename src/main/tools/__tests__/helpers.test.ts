import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { FileTouchAction } from '@shared/projectMemory.types'
import { composeDenialMessage, runGuardedTool, runReadTool } from '../helpers'
import { createMockContext, captureConfirmations } from './test-helpers'

const recordTouchMock = vi.fn<(projectId: string, path: string, action: FileTouchAction) => void>()

// Hoisted above the `helpers` import, so `recordTouch` calls this mock
// instead of the real singleton (uninitialized in tests, would write to cwd).
vi.mock('../../projects/ProjectMemoryStore', () => ({
  projectMemoryStore: {
    recordTouch: (projectId: string, path: string, action: FileTouchAction) =>
      recordTouchMock(projectId, path, action)
  }
}))

describe('recordTouch (exercised via runReadTool)', () => {
  const root = 'C:\\workspace'

  beforeEach(() => recordTouchMock.mockReset())

  it('does nothing without an active project', async () => {
    const ctx = { ...createMockContext(root), projectId: null }
    await runReadTool(ctx, {
      name: 'read_file',
      kind: 'read',
      title: 'Read',
      touch: { path: 'foo.ts', action: 'read' },
      run: () => Promise.resolve({ modelResult: 'ok' })
    })

    expect(recordTouchMock).not.toHaveBeenCalled()
  })

  it('normalizes an equivalent relative path spelling before recording', async () => {
    const ctx = { ...createMockContext(root), projectId: 'project-1' }
    await runReadTool(ctx, {
      name: 'read_file',
      kind: 'read',
      title: 'Read',
      touch: { path: './foo.ts', action: 'read' },
      run: () => Promise.resolve({ modelResult: 'ok' })
    })

    expect(recordTouchMock).toHaveBeenCalledWith('project-1', 'foo.ts', 'read')
  })

  it('records every touch when given an array, e.g. from read_multiple_files', async () => {
    const ctx = { ...createMockContext(root), projectId: 'project-1' }
    await runReadTool(ctx, {
      name: 'read_multiple_files',
      kind: 'read',
      title: 'Read',
      touch: [
        { path: 'a.ts', action: 'read' },
        { path: 'b.ts', action: 'read' }
      ],
      run: () => Promise.resolve({ modelResult: 'ok' })
    })

    expect(recordTouchMock).toHaveBeenCalledTimes(2)
    expect(recordTouchMock).toHaveBeenNthCalledWith(1, 'project-1', 'a.ts', 'read')
    expect(recordTouchMock).toHaveBeenNthCalledWith(2, 'project-1', 'b.ts', 'read')
  })

  it('falls back to the raw path if it cannot be resolved against the workspace', async () => {
    const ctx = { ...createMockContext(root), projectId: 'project-1' }
    await runReadTool(ctx, {
      name: 'read_file',
      kind: 'read',
      title: 'Read',
      touch: { path: '..\\outside.ts', action: 'read' },
      run: () => Promise.resolve({ modelResult: 'ok' })
    })

    expect(recordTouchMock).toHaveBeenCalledWith('project-1', '..\\outside.ts', 'read')
  })
})

describe('runGuardedTool — untethered turn gate', () => {
  const root = 'C:\\workspace'

  function guardedSpec(risk: 'trivial' | 'safe' | 'sensitive' | 'destructive') {
    return {
      name: 'write_file',
      kind: 'write' as const,
      title: 'Write file',
      confirmDetail: 'foo.ts',
      risk,
      run: () => Promise.resolve({ modelResult: 'ok' })
    }
  }

  it('gates the first safe call in untethered mode, with turnGate: true on the request', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'untethered' as const, confirm }

    await runGuardedTool(ctx, guardedSpec('safe'))

    expect(requests).toHaveLength(1)
    expect(requests[0].turnGate).toBe(true)
  })

  it('does not re-gate a second guarded call in the same turn once approved', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'untethered' as const, confirm }

    await runGuardedTool(ctx, guardedSpec('safe'))
    await runGuardedTool(ctx, guardedSpec('sensitive'))

    expect(requests).toHaveLength(1)
    expect(ctx.turnGate.approved).toBe(true)
  })

  it('leaves ask/full mode behavior unchanged — every guarded call still confirms', async () => {
    for (const mode of ['ask', 'full'] as const) {
      const { requests, confirm } = captureConfirmations()
      const ctx = { ...createMockContext(root), permissionMode: mode, confirm }

      await runGuardedTool(ctx, guardedSpec('safe'))
      await runGuardedTool(ctx, guardedSpec('safe'))

      expect(requests).toHaveLength(mode === 'ask' ? 2 : 0)
    }
  })

  it('never gates trivial-risk calls, even in untethered mode', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'untethered' as const, confirm }

    await runGuardedTool(ctx, guardedSpec('trivial'))

    expect(requests).toHaveLength(0)
  })

  it('still always confirms destructive calls, gate or no gate', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'untethered' as const, confirm }

    await runGuardedTool(ctx, guardedSpec('safe'))
    await runGuardedTool(ctx, guardedSpec('destructive'))

    expect(requests).toHaveLength(2)
    expect(requests[1].turnGate).toBeFalsy()
  })
})

describe('composeDenialMessage', () => {
  it('returns the generic message when no reason is given', () => {
    expect(composeDenialMessage()).toBe(
      'The user denied this action. Do not retry it — ask how they would like to proceed.'
    )
  })

  it('treats a whitespace-only reason as no reason', () => {
    expect(composeDenialMessage('   ')).toBe(
      'The user denied this action. Do not retry it — ask how they would like to proceed.'
    )
  })

  it('weaves a typed reason into the message', () => {
    expect(composeDenialMessage('use a different file name')).toBe(
      'The user denied this action for this reason: "use a different file name". Do not retry it — adjust your approach based on their feedback.'
    )
  })

  it('trims surrounding whitespace from the reason', () => {
    expect(composeDenialMessage('  no  ')).toBe(
      'The user denied this action for this reason: "no". Do not retry it — adjust your approach based on their feedback.'
    )
  })
})
