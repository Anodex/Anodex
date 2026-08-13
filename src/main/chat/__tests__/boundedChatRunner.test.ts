import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ChatRequest } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import { runGeneration, type RunGenerationIo, type RunGenerationResult } from '../runGeneration'
import { runBoundedChatGeneration } from '../boundedChatRunner'

vi.mock('../runGeneration', () => ({
  runGeneration: vi.fn()
}))

// The mock's `getState` closure only reads `workspace` when actually called
// (well after this file's own top-level code below has run), so it's safe
// for `vi.mock`'s hoisted registration to reference a `const` declared later
// in this same file — unlike `vi.hoisted`, which runs before this file's own
// imports initialize and can't touch them at all.
vi.mock('../../projects/ProjectStore', () => ({
  projectStore: {
    getState: () => ({
      activeProjectId: 'project-1',
      projects: [{ id: 'project-1', folderPath: workspace }]
    })
  }
}))

// A real workspace so `findUnverifiedPathClaims` (see `pathClaimVerification.ts`)
// has genuine disk state to check the final reply against — one real file,
// so a test can prove a path that WAS actually read is never flagged.
const workspace = mkdtempSync(join(tmpdir(), 'anodex-bounded-chat-'))
mkdirSync(join(workspace, 'src'), { recursive: true })
writeFileSync(join(workspace, 'src', 'real.ts'), 'export {}')

const mockedRunGeneration = vi.mocked(runGeneration)

function baseRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    conversationId: 'conv-1',
    messageId: 'msg-1',
    history: [],
    prompt: 'audit the project',
    ...overrides
  }
}

function baseIo(overrides: Partial<RunGenerationIo> = {}): RunGenerationIo {
  return {
    confirm: () => Promise.resolve({ approved: true }),
    ...overrides
  }
}

function result(overrides: Partial<RunGenerationResult> = {}): RunGenerationResult {
  return {
    content: '',
    stats: { tokens: 0, durationMs: 0, tokensPerSecond: 0 },
    stopped: false,
    ...overrides
  }
}

describe('runBoundedChatGeneration', () => {
  it('returns a single cycle unchanged when the turn finishes normally', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockResolvedValueOnce(
      result({ content: 'Done.', stats: { tokens: 10, durationMs: 100, tokensPerSecond: 100 } })
    )

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledOnce()
    expect(outcome.content).toBe('Done.')
    expect(outcome.stopped).toBe(false)
    expect(outcome.stats.tokens).toBe(10)
  })

  it('reconciles an unfinished visible plan in one tool-restricted final pass', async () => {
    const plan = {
      title: 'Build the feature',
      steps: [
        { id: 'step-1', title: 'Implement it', status: 'in_progress' as const },
        { id: 'step-2', title: 'Verify it', status: 'pending' as const }
      ],
      updatedAt: 1
    }
    const completedPlan = {
      ...plan,
      steps: plan.steps.map((step) => ({ ...step, status: 'completed' as const })),
      updatedAt: 2
    }
    const activities: ToolCall[] = []
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        // Reconciliation presupposes that work happened — it exists to close
        // the gap between finished work and a plan that still says pending.
        io.onActivity?.({
          id: 'edit-1',
          name: 'edit_file',
          kind: 'write',
          title: 'Edit src/feature.ts',
          status: 'success'
        })
        return Promise.resolve(
          result({ content: 'Done.', stats: { tokens: 10, durationMs: 100, tokensPerSecond: 100 } })
        )
      })
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'plan-complete',
          name: 'update_plan_step',
          kind: 'plan',
          title: 'Update plan step 2',
          status: 'success',
          plan: completedPlan
        })
        return Promise.resolve(
          result({
            content: 'PLAN_UNCHANGED',
            stats: { tokens: 2, durationMs: 20, tokensPerSecond: 100 }
          })
        )
      })

    const outcome = await runBoundedChatGeneration(
      baseRequest({ plan }),
      baseIo({ onActivity: (call) => activities.push(call) })
    )

    expect(mockedRunGeneration).toHaveBeenCalledTimes(2)
    expect(mockedRunGeneration.mock.calls[1][0].prompt).toContain(
      'reconcile the current visible work plan'
    )
    expect(mockedRunGeneration.mock.calls[1][1].enabledTools).toEqual(new Set(['update_plan_step']))
    expect(outcome.content).toBe('Done.')
    expect(outcome.stats.tokens).toBe(12)
    expect(activities.at(-1)?.plan?.steps.every((step) => step.status === 'completed')).toBe(true)
  })

  /**
   * The central honesty gate for chat `c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef`:
   * the model was asked to "confirm by using vision", inspected once at the
   * START of the turn, then edited the file and reported success without ever
   * looking again. A screenshot taken before an edit says nothing about the
   * state after it.
   */
  describe('visual verification gate', () => {
    function replyWith(calls: ToolCall[], content: string): void {
      mockedRunGeneration.mockReset()
      mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
        for (const call of calls) io.onActivity?.(call)
        return Promise.resolve(
          result({ content, stats: { tokens: 5, durationMs: 50, tokensPerSecond: 100 } })
        )
      })
    }

    const inspect = (id: string): ToolCall => ({
      id,
      name: 'inspect_visual',
      kind: 'read',
      title: 'Inspect index.html',
      status: 'success'
    })
    const edit = (id: string): ToolCall => ({
      id,
      name: 'edit_file',
      kind: 'write',
      title: 'Edit js/universe-sandbox.js',
      status: 'success'
    })

    it('flags a visual claim whose only inspection came before the last edit', async () => {
      replyWith(
        [inspect('look-1'), edit('edit-1')],
        'I found the bug and fixed it — the canvas now renders correctly.'
      )

      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

      expect(outcome.content).toContain('Visual verification note')
      expect(outcome.content).toContain('BEFORE the last change')
      expect(outcome.content).toContain('sectionId')
    })

    it('accepts a visual claim inspected after the last edit', async () => {
      replyWith(
        [inspect('look-1'), edit('edit-1'), inspect('look-2')],
        'Fixed — the canvas now renders correctly.'
      )

      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

      expect(outcome.content).not.toContain('Visual verification note')
    })

    it('flags a visual claim with no inspection at all', async () => {
      replyWith([edit('edit-1')], 'The sandbox is fixed and the scene displays correctly.')

      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

      expect(outcome.content).toContain('no successful visual inspection ran')
    })

    it('stays quiet when the reply already admits it is unverified', async () => {
      replyWith(
        [edit('edit-1')],
        'I changed the canvas setup, but this is unverified — I could not confirm it renders.'
      )

      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

      expect(outcome.content).not.toContain('Visual verification note')
    })

    it('stays quiet for a reply making no visual claim', async () => {
      replyWith([edit('edit-1')], 'Renamed the helper and updated its call sites.')

      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

      expect(outcome.content).not.toContain('Visual verification note')
    })
  })

  it('skips plan reconciliation when the reply produced no real work', async () => {
    const plan = {
      title: 'Fix the sandbox',
      steps: [
        { id: 'step-1', title: 'Diagnose', status: 'in_progress' as const },
        { id: 'step-2', title: 'Verify', status: 'pending' as const }
      ],
      updatedAt: 1
    }
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
      // Only plan bookkeeping — exactly the turn shape that used to invite one
      // more status-only generation on top of the churn.
      io.onActivity?.({
        id: 'plan-1',
        name: 'update_plan_step',
        kind: 'plan',
        title: 'Update plan step 1',
        status: 'success',
        plan
      })
      return Promise.resolve(
        result({
          content: 'Made progress.',
          stats: { tokens: 5, durationMs: 50, tokensPerSecond: 100 }
        })
      )
    })

    await runBoundedChatGeneration(baseRequest({ plan }), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledTimes(1)
  })

  it('warns when a build diagnosis was not verified by a build or test command', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockResolvedValueOnce(
      result({ content: 'Build issue: this structural fix will make it run.' })
    )

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(outcome.content).toContain('Build verification note')
    expect(outcome.content).toContain('not a verified fix')
  })

  it('does not warn when a build command actually completed', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
      io.onActivity?.({
        id: 'build-1',
        name: 'run_command',
        kind: 'command',
        title: 'Run: npm run build',
        detail: 'exit 0',
        status: 'success'
      })
      return Promise.resolve(result({ content: 'Build issue: the fix is verified.' }))
    })

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(outcome.content).not.toContain('Build verification note')
  })

  it('automatically continues after a recoverable stop that made real progress', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockResolvedValueOnce(
        result({
          content: 'Partial audit so far.',
          stopped: true,
          stopReason: 'token-limit',
          stats: { tokens: 100, durationMs: 1_000, tokensPerSecond: 100 }
        })
      )
      .mockResolvedValueOnce(
        result({
          content: 'Finished the audit.',
          stopped: false,
          stats: { tokens: 20, durationMs: 200, tokensPerSecond: 100 }
        })
      )

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledTimes(2)
    // Both cycles' visible text are stitched into one combined reply.
    expect(outcome.content).toBe('Partial audit so far.\n\nFinished the audit.')
    // Cross-cycle token/duration totals, not just the last cycle's own stats.
    expect(outcome.stats.tokens).toBe(120)
    expect(outcome.stats.durationMs).toBe(1_200)
    expect(outcome.stopped).toBe(false)

    // The second call continues the same turn: the first cycle's own
    // exchange is folded into history, and the prompt is a continuation
    // nudge, not a repeat of the original request.
    const secondCallArgs = mockedRunGeneration.mock.calls[1][0]
    expect(secondCallArgs.history).toEqual([
      { role: 'user', content: 'audit the project' },
      { role: 'assistant', content: 'Partial audit so far.' }
    ])
    expect(secondCallArgs.prompt).not.toBe('audit the project')
    expect(secondCallArgs.prompt.length).toBeGreaterThan(0)
  })

  it("carries this cycle's tool calls into the continuation history, not just its visible text", async () => {
    // Regression: a live retest showed a later cycle respond "I notice
    // there's no actual prior work in this conversation to continue from —
    // I need to start the architecture audit fresh," despite 30+ real tool
    // calls already having happened. Cause: a mid-turn session rebuild
    // (proactive/reactive compaction — see `LlamaService.ensureSession`)
    // replays the *explicit* `history` array from scratch, and an assistant
    // turn with no `toolCalls` carries no record of what was actually read —
    // only `ToolCall.result` does (see its doc comment in `tools.types.ts`).
    // Without this, every earlier cycle's tool work is invisible to the
    // model the moment any compaction happens to fire between cycles.
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'call-1',
          name: 'read_file_range',
          kind: 'read',
          title: 'Read src/index.ts',
          status: 'success',
          result: 'export const x = 1'
        })
        return Promise.resolve(
          result({
            content: 'Read the entry point.',
            stopped: true,
            stopReason: 'context-shift-limit',
            stats: { tokens: 40, durationMs: 400, tokensPerSecond: 100 }
          })
        )
      })
      .mockResolvedValueOnce(
        result({ content: 'Done.', stats: { tokens: 10, durationMs: 100, tokensPerSecond: 100 } })
      )

    await runBoundedChatGeneration(baseRequest(), baseIo())

    const secondCallArgs = mockedRunGeneration.mock.calls[1][0]
    const assistantTurn = secondCallArgs.history[1]
    expect(assistantTurn.toolCalls).toHaveLength(1)
    expect(assistantTurn.toolCalls?.[0]).toMatchObject({
      id: 'call-1',
      name: 'read_file_range',
      result: 'export const x = 1'
    })
  })

  it('carries the latest visible plan into the next continuation epoch', async () => {
    const plan = {
      title: 'Build the feature',
      steps: [
        { id: 'step-1', title: 'Implement it', status: 'in_progress' as const },
        { id: 'step-2', title: 'Verify it', status: 'pending' as const }
      ],
      updatedAt: 1
    }

    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'plan-1',
          name: 'write_plan',
          kind: 'plan',
          title: 'Create plan',
          status: 'success',
          plan
        } as unknown as ToolCall)
        return Promise.resolve(
          result({
            content: 'Started the implementation.',
            stopped: true,
            stopReason: 'context-limit',
            stats: { tokens: 40, durationMs: 400, tokensPerSecond: 100 }
          })
        )
      })
      .mockResolvedValueOnce(result({ content: 'Finished verification.' }))

    await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration.mock.calls[1][0].plan).toEqual(plan)
  })

  it('continues progress via a real tool call even when no visible text streamed yet', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'call-1',
          name: 'read_file_range',
          kind: 'read',
          title: 'Read src/index.ts',
          status: 'success'
        })
        return Promise.resolve(
          result({
            content: '',
            stopped: true,
            stopReason: 'tool-limit',
            stats: { tokens: 50, durationMs: 500, tokensPerSecond: 100 }
          })
        )
      })
      .mockResolvedValueOnce(
        result({
          content: 'Here is the audit.',
          stats: { tokens: 30, durationMs: 300, tokensPerSecond: 100 }
        })
      )

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledTimes(2)
    // The first cycle produced no visible text (only a tool call), so the
    // combined reply isn't padded with a leading blank line for it.
    expect(outcome.content).toBe('Here is the audit.')
  })

  it('does not continue after a recoverable stop that made no real progress', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockResolvedValueOnce(
      result({
        content: '',
        stopped: true,
        stopReason: 'token-limit',
        stats: { tokens: 5, durationMs: 50, tokensPerSecond: 100 }
      })
    )

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledOnce()
    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('token-limit')
  })

  it('does not continue after a non-recoverable stop, even with progress', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockResolvedValueOnce(
      result({
        content: 'Some real work happened.',
        stopped: true,
        stopReason: 'fixed-context-limit',
        stats: { tokens: 5, durationMs: 50, tokensPerSecond: 100 }
      })
    )

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledOnce()
    expect(outcome.stopReason).toBe('fixed-context-limit')
  })

  it('does not continue once a real user Stop occurred', async () => {
    mockedRunGeneration.mockReset()
    const controller = new AbortController()
    mockedRunGeneration.mockImplementationOnce(() => {
      controller.abort()
      return Promise.resolve(
        result({
          content: 'Interrupted mid-audit.',
          stopped: true,
          stopReason: 'token-limit',
          stats: { tokens: 5, durationMs: 50, tokensPerSecond: 100 }
        })
      )
    })

    const outcome = await runBoundedChatGeneration(
      baseRequest(),
      baseIo({ signal: controller.signal })
    )

    expect(mockedRunGeneration).toHaveBeenCalledOnce()
    expect(outcome.stopped).toBe(true)
  })

  it('caps the number of cycles even when every cycle keeps making progress', async () => {
    mockedRunGeneration.mockReset()
    let cycleNumber = 0
    mockedRunGeneration.mockImplementation((_request, io: RunGenerationIo) => {
      cycleNumber += 1
      io.onActivity?.({
        id: `call-${cycleNumber}`,
        name: 'read_file',
        kind: 'read',
        title: `Read src/file-${cycleNumber}.ts`,
        status: 'success'
      })
      return Promise.resolve(
        result({
          content: 'more work',
          stopped: true,
          stopReason: 'tool-limit',
          stats: { tokens: 1, durationMs: 1, tokensPerSecond: 1 }
        })
      )
    })

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    // 24 cycles total (MAX_CYCLES): every one reported recoverable + progress,
    // so only the hard cycle cap itself ends the loop.
    expect(mockedRunGeneration).toHaveBeenCalledTimes(24)
    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('tool-limit')
  })

  it('stops a continuation when the next cycle only repeats prior work', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementation((_request, io: RunGenerationIo) => {
      io.onActivity?.({
        id: 'same-call',
        name: 'run_command',
        kind: 'command',
        title: 'Run npm test',
        status: 'success'
      })
      return Promise.resolve(
        result({
          content: 'I am still investigating the same issue.',
          stopped: true,
          stopReason: 'rounds-exhausted',
          stats: { tokens: 1, durationMs: 1, tokensPerSecond: 1 }
        })
      )
    })

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledTimes(2)
    expect(outcome.stopReason).toBe('rounds-exhausted')
  })

  it('forwards a later cycle onActivity/onToken through to the caller-supplied io', async () => {
    mockedRunGeneration.mockReset()
    const seenActivity: ToolCall[] = []
    mockedRunGeneration.mockResolvedValueOnce(
      result({ content: 'Done.', stats: { tokens: 1, durationMs: 1, tokensPerSecond: 1 } })
    )

    await runBoundedChatGeneration(
      baseRequest(),
      baseIo({ onActivity: (call) => seenActivity.push(call) })
    )

    // Drive the mocked call's io directly to prove the wrapper composes with,
    // rather than replaces, the caller's own onActivity.
    const [, io] = mockedRunGeneration.mock.calls[0]
    io.onActivity?.({
      id: 'call-1',
      name: 'list_directory',
      kind: 'read',
      title: 'List .',
      status: 'success'
    })

    expect(seenActivity).toHaveLength(1)
    expect(seenActivity[0].name).toBe('list_directory')
  })

  it('shares one readCoverage tracker across every cycle of the same bounded reply', async () => {
    // See `ReadCoverageTracker`'s doc comment — a fresh tracker per cycle
    // would defeat the whole point (a later cycle needs to see what an
    // earlier cycle already read).
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockResolvedValueOnce(
        result({
          content: 'Partial.',
          stopped: true,
          stopReason: 'token-limit',
          stats: { tokens: 10, durationMs: 100, tokensPerSecond: 100 }
        })
      )
      .mockResolvedValueOnce(
        result({ content: 'Done.', stats: { tokens: 5, durationMs: 50, tokensPerSecond: 100 } })
      )

    await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledTimes(2)
    const firstIo = mockedRunGeneration.mock.calls[0][1]
    const secondIo = mockedRunGeneration.mock.calls[1][1]
    expect(firstIo.readCoverage).toBeDefined()
    expect(secondIo.readCoverage).toBe(firstIo.readCoverage)
  })

  describe('unverified path claims (fabrication guard)', () => {
    it('appends a note when the reply cites a file that does not exist', async () => {
      // Regression: a live retest's final synthesis cycle (zero new tool
      // calls) cited `src/main/ipc/tool.handlers.ts` and other nonexistent
      // paths in a fabricated-looking table — see
      // `pathClaimVerification.ts`'s doc comment.
      mockedRunGeneration.mockReset()
      mockedRunGeneration.mockResolvedValueOnce(
        result({
          content: 'See `src/main/ipc/tool.handlers.ts` for the IPC layer.',
          stats: { tokens: 5, durationMs: 50, tokensPerSecond: 100 }
        })
      )

      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

      expect(outcome.content).toContain('src/main/ipc/tool.handlers.ts')
      expect(outcome.content).toContain('not verified against real tool calls')
      expect(outcome.content).toContain('likely fabricated or misspelled')
    })

    it('does not append a note when every cited path was actually read this task', async () => {
      mockedRunGeneration.mockReset()
      mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'call-1',
          name: 'read_file_range',
          kind: 'read',
          title: 'Read src/real.ts lines 1-1',
          status: 'success'
        })
        io.readCoverage?.recordRange(join(workspace, 'src', 'real.ts'), 1, 1)
        return Promise.resolve(
          result({
            content: 'See `src/real.ts` for details.',
            stats: { tokens: 5, durationMs: 50, tokensPerSecond: 100 }
          })
        )
      })

      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

      expect(outcome.content).toBe('See `src/real.ts` for details.')
      expect(outcome.content).not.toContain('not verified')
    })
  })
})

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})
