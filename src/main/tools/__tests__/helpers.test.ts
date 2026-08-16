import { describe, expect, it, vi, beforeEach } from 'vitest'
import { join, resolve } from 'node:path'
import type { FileTouchAction } from '@shared/projectMemory.types'
import {
  composeDenialMessage,
  runGuardedTool,
  runGuardedToolWithPrepare,
  runReadTool
} from '../helpers'
import { createMockContext, captureCalls, captureConfirmations } from './test-helpers'

/**
 * An absolute workspace root on whatever OS is running the suite.
 *
 * This was the literal `C:\workspace`, which is only absolute on Windows —
 * elsewhere the tools resolved it against the cwd and the expected paths below
 * stopped matching what the code produced.
 */
const WORKSPACE_ROOT = resolve('/anodex-test/workspace')

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
  const root = WORKSPACE_ROOT

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

describe('runGuardedTool — first-action turn gate (full mode only)', () => {
  const root = WORKSPACE_ROOT

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

  it('gates the first safe call in full mode, with turnGate: true on the request', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'full' as const, confirm }

    await runGuardedTool(ctx, guardedSpec('safe'))

    expect(requests).toHaveLength(1)
    expect(requests[0].turnGate).toBe(true)
  })

  it('does not re-gate a second guarded call in the same turn once approved', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'full' as const, confirm }

    await runGuardedTool(ctx, guardedSpec('safe'))
    await runGuardedTool(ctx, guardedSpec('safe'))

    expect(requests).toHaveLength(1)
    expect(ctx.turnGate.approved).toBe(true)
  })

  it('leaves ask mode behavior unchanged — every guarded call still confirms', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'ask' as const, confirm }

    await runGuardedTool(ctx, guardedSpec('safe'))
    await runGuardedTool(ctx, guardedSpec('safe'))

    expect(requests).toHaveLength(2)
  })

  it('never gates trivial-risk calls, even in full mode', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'full' as const, confirm }

    await runGuardedTool(ctx, guardedSpec('trivial'))

    expect(requests).toHaveLength(0)
  })

  it('still always confirms destructive calls, gate or no gate', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'full' as const, confirm }

    await runGuardedTool(ctx, guardedSpec('safe'))
    await runGuardedTool(ctx, guardedSpec('destructive'))

    expect(requests).toHaveLength(2)
    expect(requests[1].turnGate).toBeFalsy()
  })

  it("forceConfirm: false does not bypass the turn gate (web_search's bug)", async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'full' as const, confirm }

    await runGuardedTool(ctx, { ...guardedSpec('safe'), forceConfirm: false })

    expect(requests).toHaveLength(1)
    expect(requests[0].turnGate).toBe(true)
  })

  it('forceConfirm: true still forces its own confirmation, unaffected by the fix', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'full' as const, confirm }

    await runGuardedTool(ctx, { ...guardedSpec('trivial'), forceConfirm: true })

    expect(requests).toHaveLength(1)
  })

  it('approving an unrelated forced confirmation does not satisfy the turn gate', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'full' as const, confirm }

    // Forced independently of risk/mode — not the turn's own checkpoint.
    await runGuardedTool(ctx, { ...guardedSpec('trivial'), forceConfirm: true })
    expect(ctx.turnGate.approved).toBe(false)

    // The real first safe action still has to show its own gate.
    await runGuardedTool(ctx, guardedSpec('safe'))
    expect(requests).toHaveLength(2)
    expect(requests[1].turnGate).toBe(true)
  })

  it('approving a destructive confirmation does not satisfy the turn gate either', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'full' as const, confirm }

    await runGuardedTool(ctx, guardedSpec('destructive'))
    expect(ctx.turnGate.approved).toBe(false)

    await runGuardedTool(ctx, guardedSpec('safe'))
    expect(requests).toHaveLength(2)
    expect(requests[1].turnGate).toBe(true)
  })
})

describe('runGuardedTool — untethered mode has almost no prompts', () => {
  const root = WORKSPACE_ROOT

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

  it('never gates the first safe/sensitive call — no turn-gate checkpoint at all', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'untethered' as const, confirm }

    await runGuardedTool(ctx, guardedSpec('safe'))
    await runGuardedTool(ctx, guardedSpec('sensitive'))

    expect(requests).toHaveLength(0)
  })

  it('still always confirms destructive calls', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'untethered' as const, confirm }

    await runGuardedTool(ctx, guardedSpec('safe'))
    await runGuardedTool(ctx, guardedSpec('destructive'))

    expect(requests).toHaveLength(1)
    expect(requests[0].turnGate).toBeFalsy()
  })
})

describe('ctx.progress (finish_goal fabrication guard)', () => {
  const root = WORKSPACE_ROOT

  it('runReadTool does not mark progress for a read-kind call', async () => {
    const ctx = createMockContext(root)
    await runReadTool(ctx, {
      name: 'read_file',
      kind: 'read',
      title: 'Read',
      run: () => Promise.resolve({ modelResult: 'ok' })
    })

    expect(ctx.progress.madeChange).toBe(false)
  })

  it('runReadTool does not mark progress for plan bookkeeping', async () => {
    // Writing down an intention is not carrying it out. An agent run exists to
    // do the work it was given, so a plan a model wrote for itself must not let
    // `finish_goal` declare that work done.
    const ctx = createMockContext(root)
    await runReadTool(ctx, {
      name: 'write_plan',
      kind: 'plan',
      title: 'Write plan',
      run: () => Promise.resolve({ modelResult: 'ok' })
    })

    expect(ctx.progress.madeChange).toBe(false)
  })

  it('runReadTool marks progress for a web-kind call', async () => {
    // The exclusion is `read` and `plan` specifically, not "anything that is
    // not a write" — fetching a page is real work a goal can genuinely need.
    const ctx = createMockContext(root)
    await runReadTool(ctx, {
      name: 'fetch_url',
      kind: 'web',
      title: 'Fetch',
      run: () => Promise.resolve({ modelResult: 'ok' })
    })

    expect(ctx.progress.madeChange).toBe(true)
  })

  it('runReadTool never marks progress for finish_goal itself', async () => {
    const ctx = createMockContext(root)
    await runReadTool(ctx, {
      name: 'finish_goal',
      kind: 'plan',
      title: 'Finish goal',
      run: () => Promise.resolve({ modelResult: 'ok' })
    })

    expect(ctx.progress.madeChange).toBe(false)
  })

  it('runReadTool does not mark progress when the call errors', async () => {
    const ctx = createMockContext(root)
    await runReadTool(ctx, {
      name: 'write_plan',
      kind: 'plan',
      title: 'Write plan',
      run: () => Promise.reject(new Error('boom'))
    })

    expect(ctx.progress.madeChange).toBe(false)
  })

  it('runGuardedTool marks progress once a write succeeds', async () => {
    const { confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'ask' as const, confirm }

    await runGuardedTool(ctx, {
      name: 'write_file',
      kind: 'write',
      title: 'Write file',
      confirmDetail: 'foo.ts',
      risk: 'safe',
      run: () => Promise.resolve({ modelResult: 'ok' })
    })

    expect(ctx.progress.madeChange).toBe(true)
  })

  it('runGuardedTool does not mark progress when the user denies the call', async () => {
    const ctx = {
      ...createMockContext(root),
      permissionMode: 'ask' as const,
      confirm: () => Promise.resolve({ approved: false })
    }

    await runGuardedTool(ctx, {
      name: 'write_file',
      kind: 'write',
      title: 'Write file',
      confirmDetail: 'foo.ts',
      risk: 'safe',
      run: () => Promise.resolve({ modelResult: 'ok' })
    })

    expect(ctx.progress.madeChange).toBe(false)
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

describe('loop guard (exercised via runReadTool / runGuardedTool)', () => {
  const root = WORKSPACE_ROOT

  function readSpec(title: string) {
    return {
      name: 'find_skill',
      kind: 'read' as const,
      title,
      run: () => Promise.resolve({ modelResult: 'ok' })
    }
  }

  function guardedSpec(title: string) {
    return {
      name: 'write_file',
      kind: 'write' as const,
      title,
      confirmDetail: 'foo.ts',
      risk: 'safe' as const,
      run: () => Promise.resolve({ modelResult: 'ok' })
    }
  }

  it('lets identical read-tool calls through up to the limit, then blocks without running them', async () => {
    const ctx = createMockContext(root)
    const runMock = vi.fn(() => Promise.resolve({ modelResult: 'ok' }))

    for (let i = 0; i < 3; i++) {
      const result = await runReadTool(ctx, { ...readSpec('Find skill "foo"'), run: runMock })
      expect(result).toBe('ok')
    }
    expect(runMock).toHaveBeenCalledTimes(3)

    const blocked = await runReadTool(ctx, { ...readSpec('Find skill "foo"'), run: runMock })
    expect(blocked).toContain('find_skill')
    expect(blocked).toContain('loop')
    // The underlying call is never actually executed once blocked.
    expect(runMock).toHaveBeenCalledTimes(3)
  })

  it('does not block calls to the same tool with different arguments', async () => {
    const ctx = createMockContext(root)
    for (let i = 0; i < 3; i++) {
      const result = await runReadTool(ctx, readSpec('Find skill "foo"'))
      expect(result).toBe('ok')
    }
    // A genuinely different query is a different call, not a repeat.
    const result = await runReadTool(ctx, readSpec('Find skill "bar"'))
    expect(result).toBe('ok')
  })

  it('also blocks a guarded tool repeated past the limit, before any confirm prompt', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'ask' as const, confirm }

    for (let i = 0; i < 3; i++) {
      await runGuardedTool(ctx, guardedSpec('Write file: same.ts'))
    }
    expect(requests).toHaveLength(3)

    const blocked = await runGuardedTool(ctx, guardedSpec('Write file: same.ts'))
    expect(blocked).toContain('write_file')
    // Blocked before the confirm prompt — the user is never asked a 4th time.
    expect(requests).toHaveLength(3)
  })

  it('does not block a guarded tool sharing a title when args differ — the write_file scenario', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(root), permissionMode: 'ask' as const, confirm }

    // Same path (and thus same title, "Write foo.ts"), four different
    // contents in a row — exactly the concrete scenario both independent
    // reviews of this codebase flagged as wrongly blocked by a title-only key.
    for (const content of ['one', 'two', 'three', 'four']) {
      const result = await runGuardedTool(ctx, {
        ...guardedSpec('Write foo.ts'),
        args: { path: 'foo.ts', content }
      })
      expect(result).not.toContain('loop')
    }
    expect(requests).toHaveLength(4)
  })

  it('force-aborts generation once a blocked read-tool call keeps repeating', async () => {
    const abortGeneration = vi.fn()
    const ctx = { ...createMockContext(root), abortGeneration }

    // 3 pass through for real, then 3 more get blocked-with-a-message before
    // the abort threshold (LOOP_GUARD_LIMIT + 3) is reached on the 6th call.
    for (let i = 0; i < 5; i++) {
      await runReadTool(ctx, readSpec('Find skill "foo"'))
      expect(abortGeneration).not.toHaveBeenCalled()
    }
    await runReadTool(ctx, readSpec('Find skill "foo"'))
    expect(abortGeneration).toHaveBeenCalledTimes(1)
  })

  it('force-aborts generation once a blocked guarded-tool call keeps repeating', async () => {
    const abortGeneration = vi.fn()
    const { confirm } = captureConfirmations()
    const ctx = {
      ...createMockContext(root),
      permissionMode: 'ask' as const,
      confirm,
      abortGeneration
    }

    for (let i = 0; i < 5; i++) {
      await runGuardedTool(ctx, guardedSpec('Write file: same.ts'))
      expect(abortGeneration).not.toHaveBeenCalled()
    }
    await runGuardedTool(ctx, guardedSpec('Write file: same.ts'))
    expect(abortGeneration).toHaveBeenCalledTimes(1)
  })

  it('is safe for custom tool contexts to omit abortGeneration', async () => {
    const ctx = createMockContext(root)
    for (let i = 0; i < 8; i++) {
      const result = await runReadTool(ctx, readSpec('Find skill "foo"'))
      expect(typeof result).toBe('string')
    }
  })

  it('does not falsely claim generation is stopping when abortGeneration is absent', async () => {
    // A custom caller can still omit the callback. The first-party model
    // transports all wire one, but the shared tool helpers remain optional.
    const ctx = createMockContext(root)
    let last = ''
    for (let i = 0; i < 6; i++) {
      last = await runReadTool(ctx, readSpec('Find skill "foo"'))
    }
    expect(last.toLowerCase()).not.toContain('stopped')
  })

  it('does claim generation is stopping when abortGeneration is actually wired up', async () => {
    const ctx = { ...createMockContext(root), abortGeneration: vi.fn() }
    let last = ''
    for (let i = 0; i < 6; i++) {
      last = await runReadTool(ctx, readSpec('Find skill "foo"'))
    }
    expect(last.toLowerCase()).toContain('stopped')
  })
})

describe('runGuardedTool — read-coverage invalidation on mutation', () => {
  const root = WORKSPACE_ROOT
  // `join`, not a backslash literal — this has to match what the tools
  // themselves produce via node:path on the running platform.
  const resolved = (relative: string): string => join(root, relative)

  function writeSpec(path: string) {
    return {
      name: 'write_file',
      kind: 'write' as const,
      title: `Write ${path}`,
      confirmDetail: path,
      risk: 'safe' as const,
      touch: { path, action: 'write' as const },
      run: () => Promise.resolve({ modelResult: 'ok' })
    }
  }

  it('invalidates full-file coverage when the same file is successfully written', async () => {
    const ctx = createMockContext(root)
    ctx.ledger.reads.recordFullFile(resolved('foo.ts'))

    await runGuardedTool(ctx, writeSpec('foo.ts'))

    expect(ctx.ledger.reads.isFullyCovered(resolved('foo.ts'))).toBe(false)
    expect(ctx.ledger.reads.hasInteracted(resolved('foo.ts'))).toBe(true)
  })

  it('invalidates even without an active project — unlike project-memory touches', async () => {
    const ctx = { ...createMockContext(root), projectId: null }
    ctx.ledger.reads.recordRange(resolved('foo.ts'), 1, 200)

    await runGuardedTool(ctx, writeSpec('foo.ts'))

    expect(ctx.ledger.reads.uncovered(resolved('foo.ts'), 1, 200)).toEqual([{ start: 1, end: 200 }])
  })

  it('invalidates every path in checkpointChanges too — a move covers its source that way', async () => {
    const ctx = createMockContext(root)
    ctx.ledger.reads.recordFullFile(resolved('old.ts'))
    ctx.ledger.reads.recordFullFile(resolved('new.ts'))

    await runGuardedTool(ctx, {
      name: 'move_file',
      kind: 'write',
      title: 'Move old.ts -> new.ts',
      confirmDetail: 'move',
      risk: 'safe',
      touch: { path: 'new.ts', action: 'move' },
      run: () =>
        Promise.resolve({
          modelResult: 'moved',
          checkpointChanges: [
            { path: 'old.ts', before: 'x', after: null },
            { path: 'new.ts', before: null, after: 'x' }
          ]
        })
    })

    expect(ctx.ledger.reads.isFullyCovered(resolved('old.ts'))).toBe(false)
    expect(ctx.ledger.reads.isFullyCovered(resolved('new.ts'))).toBe(false)
    expect(ctx.ledger.reads.hasInteracted(resolved('old.ts'))).toBe(true)
  })

  it('does not invalidate when the call is denied', async () => {
    const ctx = {
      ...createMockContext(root),
      confirm: () => Promise.resolve({ approved: false })
    }
    ctx.ledger.reads.recordFullFile(resolved('foo.ts'))

    await runGuardedTool(ctx, writeSpec('foo.ts'))

    expect(ctx.ledger.reads.isFullyCovered(resolved('foo.ts'))).toBe(true)
  })

  it('does not invalidate when run() throws', async () => {
    const ctx = createMockContext(root)
    ctx.ledger.reads.recordFullFile(resolved('foo.ts'))

    await runGuardedTool(ctx, {
      ...writeSpec('foo.ts'),
      run: () => Promise.reject(new Error('disk full'))
    })

    expect(ctx.ledger.reads.isFullyCovered(resolved('foo.ts'))).toBe(true)
  })

  it('never invalidates for read-action touches', async () => {
    const ctx = createMockContext(root)
    ctx.ledger.reads.recordFullFile(resolved('foo.ts'))

    await runReadTool(ctx, {
      name: 'read_file',
      kind: 'read',
      title: 'Read foo.ts',
      touch: { path: 'foo.ts', action: 'read' },
      run: () => Promise.resolve({ modelResult: 'ok' })
    })

    expect(ctx.ledger.reads.isFullyCovered(resolved('foo.ts'))).toBe(true)
  })
})

describe('model-result runtime budget clamping', () => {
  const root = WORKSPACE_ROOT

  it('falls back to the tool-requested cap unchanged when no runtime budget is known', async () => {
    const ctx = createMockContext(root)
    const result = await runReadTool(ctx, {
      name: 'read_file',
      kind: 'read',
      title: 'Read',
      modelResultCap: 20,
      run: () => Promise.resolve({ modelResult: 'x'.repeat(100) })
    })

    expect(result).toContain('truncated, 100 bytes total')
    expect(result.startsWith('x'.repeat(20))).toBe(true)
  })

  it('clamps the effective cap down to the runtime budget when it is tighter than the tool cap', async () => {
    const ctx = {
      ...createMockContext(root),
      modelResultBudget: {
        current: {
          contextSizeTokens: 8_192,
          inputLimitTokens: 7_373,
          fixedTokens: 4_037,
          minimumReplyReserveTokens: 1_024,
          maxTokensPerResult: 10 // → 30 chars at the module's conservative ratio
        }
      }
    }
    const result = await runReadTool(ctx, {
      name: 'read_file',
      kind: 'read',
      title: 'Read',
      modelResultCap: 60 * 1024,
      run: () => Promise.resolve({ modelResult: 'y'.repeat(1_000) })
    })

    expect(result.startsWith('y'.repeat(30))).toBe(true)
    expect(result.length).toBeLessThan(100)
  })

  it('never widens the effective cap when the tool cap is already tighter than the runtime budget', async () => {
    const ctx = {
      ...createMockContext(root),
      modelResultBudget: {
        current: {
          contextSizeTokens: 1_000_000,
          inputLimitTokens: 1_000_000,
          fixedTokens: 1_000,
          minimumReplyReserveTokens: 1_024,
          maxTokensPerResult: 100_000 // far larger than the tool's own cap below
        }
      }
    }
    const result = await runReadTool(ctx, {
      name: 'read_file',
      kind: 'read',
      title: 'Read',
      modelResultCap: 15,
      run: () => Promise.resolve({ modelResult: 'z'.repeat(1_000) })
    })

    expect(result.startsWith('z'.repeat(15))).toBe(true)
    expect(result).toContain('truncated, 1000 bytes total')
  })

  it('returns an explicit no-room message instead of an empty or misleading result', async () => {
    const ctx = {
      ...createMockContext(root),
      modelResultBudget: {
        current: {
          contextSizeTokens: 8_192,
          inputLimitTokens: 7_373,
          fixedTokens: 7_300,
          minimumReplyReserveTokens: 1_024,
          maxTokensPerResult: 0
        }
      }
    }
    const result = await runReadTool(ctx, {
      name: 'read_file',
      kind: 'read',
      title: 'Read',
      run: () => Promise.resolve({ modelResult: 'plenty of real content here' })
    })

    expect(result).toContain('No room left')
    expect(result).not.toContain('plenty of real content')
  })
})

describe('runGuardedToolWithPrepare — provisional card handoff', () => {
  const root = WORKSPACE_ROOT

  /**
   * Mirrors `PendingToolCallTracker.claim`: hands out the provisional id the
   * streaming UI already showed, once, then reports a miss.
   */
  function pendingTracker(
    name: string,
    id: string
  ): {
    claim: (tool: string) => string | undefined
    claimed: () => number
  } {
    let claims = 0
    return {
      claimed: () => claims,
      claim: (tool) => {
        if (tool !== name || claims > 0) return undefined
        claims += 1
        return id
      }
    }
  }

  it('resolves the provisional card when prepare succeeds', async () => {
    const { calls, emit } = captureCalls()
    const tracker = pendingTracker('write_file', 'provisional-1')
    const ctx = {
      ...createMockContext(root),
      permissionMode: 'untethered' as const,
      emit,
      claimPendingToolCallId: tracker.claim
    }

    await runGuardedToolWithPrepare(
      ctx,
      { name: 'write_file', kind: 'write', title: 'Write foo.ts', risk: 'safe' },
      () => Promise.resolve({ confirmDetail: 'foo.ts', data: 1 }),
      () => Promise.resolve({ modelResult: 'written' })
    )

    expect(calls.every((call) => call.id === 'provisional-1')).toBe(true)
    expect(calls.at(-1)?.status).toBe('success')
  })

  // The regression: `edit_file`'s commonest failure is an `oldText` the file
  // does not contain, and that is raised in `prepare()`. The error used to be
  // emitted under a fresh id, leaving the card the user watched stream in
  // unclaimed — so it was swept as "Interrupted" while a second card carried
  // the real reason.
  it('reports a prepare failure on the provisional card, not a second one', async () => {
    const { calls, emit } = captureCalls()
    const tracker = pendingTracker('edit_file', 'provisional-2')
    const ctx = { ...createMockContext(root), emit, claimPendingToolCallId: tracker.claim }

    const result = await runGuardedToolWithPrepare(
      ctx,
      { name: 'edit_file', kind: 'write', title: 'Edit foo.ts', risk: 'safe' },
      () => Promise.reject(new Error('oldText not found in foo.ts')),
      () => Promise.resolve({ modelResult: 'unreachable' })
    )

    expect(result).toBe('Error: oldText not found in foo.ts')
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('provisional-2')
    expect(calls[0].status).toBe('error')
    // Claimed exactly once, so nothing is left for the round sweep to mark
    // "Interrupted" and nothing is double-claimed by a later call.
    expect(tracker.claimed()).toBe(1)
  })

  it('falls back to a fresh id when nothing was pre-emitted', async () => {
    const { calls, emit } = captureCalls()
    const ctx = { ...createMockContext(root), emit, claimPendingToolCallId: () => undefined }

    await runGuardedToolWithPrepare(
      ctx,
      { name: 'delete_file', kind: 'write', title: 'Delete foo.ts', risk: 'destructive' },
      () => Promise.reject(new Error('foo.ts does not exist')),
      () => Promise.resolve({ modelResult: 'unreachable' })
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].id).toEqual(expect.any(String))
    expect(calls[0].status).toBe('error')
  })
})
