import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { FileTouchAction } from '@shared/projectMemory.types'
import { composeDenialMessage, runReadTool } from '../helpers'
import { createMockContext } from './test-helpers'

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
