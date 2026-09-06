import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRequest } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import { runGeneration, type RunGenerationIo, type RunGenerationResult } from '../runGeneration'
import { REPEATED_CALL_ALLOWANCE, runBoundedChatGeneration } from '../boundedChatRunner'

vi.mock('../runGeneration', () => ({
  runGeneration: vi.fn()
}))

// The mock's `getState` closure only reads `workspace` when actually called
// (well after this file's own top-level code below has run), so it's safe
// for `vi.mock`'s hoisted registration to reference a `const` declared later
// in this same file — unlike `vi.hoisted`, which runs before this file's own
// imports initialize and can't touch them at all.
// Real defaults, so the deadline is computed from the shipped 15-minute limit
// rather than a number invented here. A test may reassign the field.
const settings = { generation: { turnTimeLimitMinutes: 15 as number | null } }

vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: { get: () => settings }
}))

vi.mock('../../llama/LlamaService', () => ({
  llamaService: { getState: () => ({ contextSize: 16_384 }) }
}))

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

/**
 * Generation calls that were real work cycles. A turn the loop had to cut short
 * also makes one tool-less closing pass so the reply does not end mid-thought;
 * that pass is not a cycle and must not be counted as one. Identified by its
 * empty `enabledTools` — a normal cycle restricts nothing, and the plan
 * reconciliation pass allows exactly one tool.
 */
function cycleCallCount(): number {
  return mockedRunGeneration.mock.calls.filter(([, io]) => io.enabledTools?.size !== 0).length
}

/** Minimal measured budget; only `fixedTokens` matters to the epoch handoff. */
function budget(fixedTokens: number): NonNullable<RunGenerationResult['contextBudget']> {
  return {
    contextSize: 16_384,
    inputLimitTokens: 15_872,
    systemTokens: 1_200,
    promptTokens: 40,
    toolSchemaTokens: 3_220,
    fixedTokens,
    reservedTokens: 512,
    activeToolCount: 23,
    deferredToolCount: 37,
    toolRoutingApplied: true
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
      // An open plan buys one continuation: the turn worked and stopped while
      // rows were still pending, which is the shape of a stall. This cycle
      // calls nothing, which is how a genuinely finished turn ends the run.
      .mockImplementationOnce(() =>
        Promise.resolve(
          result({ content: '', stats: { tokens: 0, durationMs: 10, tokensPerSecond: 0 } })
        )
      )
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
      baseRequest({ prompt: 'continue the plan', plan }),
      baseIo({ onActivity: (call) => activities.push(call) })
    )

    expect(mockedRunGeneration).toHaveBeenCalledTimes(3)
    expect(mockedRunGeneration.mock.calls[1][0].prompt).toContain('Continue exactly where you left')
    expect(mockedRunGeneration.mock.calls[2][0].prompt).toContain(
      'reconcile the current visible work plan'
    )
    expect(mockedRunGeneration.mock.calls[2][1].enabledTools).toEqual(new Set(['update_plan_step']))
    // The reply itself is unchanged; a build-verification note now follows it,
    // because the turn edited a file and ran nothing against it.
    expect(outcome.content).toContain('Done.')
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

      expect(outcome.content).toContain('most recent screenshot')
      expect(outcome.content).toContain('most recent screenshot')
      expect(outcome.content).toContain('sectionId')
    })

    it('accepts a visual claim inspected after the last edit', async () => {
      replyWith(
        [inspect('look-1'), edit('edit-1'), inspect('look-2')],
        'Fixed — the canvas now renders correctly.'
      )

      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

      expect(outcome.content).not.toContain('most recent screenshot')
    })

    it('stays quiet for a task that never inspected anything visually', async () => {
      replyWith([edit('edit-1')], 'The sandbox is fixed and the scene displays correctly.')

      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

      // A reply that never took a screenshot is not evidence of a visual task —
      // it is the ordinary shape of every non-visual edit. The gate used to fire
      // here on the words "fixed" and "displays", which meant a backend change
      // described in the wrong vocabulary was told to go and take a screenshot.
      expect(outcome.content).not.toContain('most recent screenshot')
    })

    it('stays quiet when the reply already admits it is unverified', async () => {
      replyWith(
        [edit('edit-1')],
        'I changed the canvas setup, but this is unverified — I could not confirm it renders.'
      )

      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

      expect(outcome.content).not.toContain('most recent screenshot')
    })

    it('stays quiet for a reply making no visual claim', async () => {
      replyWith([edit('edit-1')], 'Renamed the helper and updated its call sites.')

      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

      expect(outcome.content).not.toContain('most recent screenshot')
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

    await runBoundedChatGeneration(baseRequest({ prompt: 'continue the plan', plan }), baseIo())

    // Plan bookkeeping is not durable work, so there is nothing to reconcile.
    expect(mockedRunGeneration).toHaveBeenCalledTimes(1)
  })

  it('does not reconcile a plan after a successful read redirect that returned no evidence', async () => {
    const plan = {
      title: 'Fix the sandbox',
      steps: [{ id: 'step-1', title: 'Implement and verify', status: 'in_progress' as const }],
      updatedAt: 1
    }
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
      io.onActivity?.({
        id: 'read-1',
        name: 'read_file',
        kind: 'read',
        title: 'Read src/real.ts',
        status: 'success',
        detail: 'Already read earlier this task',
        madeProgress: false
      })
      return Promise.resolve(result({ content: 'Done.' }))
    })

    await runBoundedChatGeneration(baseRequest({ prompt: 'continue the plan', plan }), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledTimes(1)
  })

  it('continues a recoverable context epoch without interpreting the model prose', async () => {
    const plan = {
      title: 'Fix Universe Sandbox',
      steps: [
        { id: 'step-1', title: 'Fix planet lighting', status: 'in_progress' as const },
        { id: 'step-2', title: 'Add moons', status: 'pending' as const }
      ],
      updatedAt: 1
    }
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'read-index',
          name: 'read_file_range',
          kind: 'read',
          title: 'Read index.html lines 290-489',
          status: 'success',
          touchedPaths: ['index.html']
        })
        return Promise.resolve(
          result({
            content:
              'This is the Chrome file issue. Let me inspect the setup and fix it so index.html works when double-clicked.',
            stopped: true,
            stopReason: 'context-limit',
            contextEpochCause: 'proactive'
          })
        )
      })
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'edit-index',
          name: 'edit_file',
          kind: 'write',
          title: 'Edit index.html',
          status: 'success',
          touchedPaths: ['index.html']
        })
        return Promise.resolve(
          result({ content: 'The edit is in place; browser verification is still pending.' })
        )
      })
      // The open plan earns a continuation; a cycle that calls nothing ends it.
      .mockResolvedValue(result({ content: '' }))

    await runBoundedChatGeneration(
      baseRequest({
        prompt: 'Opening index.html only shows a black page.',
        plan
      }),
      baseIo()
    )

    // The production failure made this read count as completed work, then ran
    // eleven update_plan_step calls over the older lighting/moons plan. The
    // correction must instead keep the normal workspace tool surface and
    // continue from measured execution state, not from the wording above.
    // Two work cycles plus the plan-reconciliation pass, which now runs whenever
    // durable work left an open plan row rather than only when the reply happened
    // to word itself as finished.
    // Two work cycles, the continuation the open plan earns, then the
    // plan-reconciliation pass.
    expect(mockedRunGeneration).toHaveBeenCalledTimes(4)
    // The unfinished plan is passed on every cycle. It used to be withheld
    // unless the prompt's wording matched a continuation pattern, which made
    // prompt phrasing an implicit control channel; the rendered plan block now
    // states its own precedence instead (see `renderCurrentPlan`).
    expect(mockedRunGeneration.mock.calls[0][0].plan).toEqual(plan)
    // Same invariant, stated directly rather than through the old fixed
    // nudge: this cycle resumes after an epoch, so the continuation restates
    // the request *verbatim*. Carrying the words through is not reading them —
    // nothing here branches on what the prompt says, which is the control
    // channel these tests exist to keep closed.
    expect(mockedRunGeneration.mock.calls[1][0].prompt).toContain(
      'Opening index.html only shows a black page.'
    )
    expect(mockedRunGeneration.mock.calls[1][1].enabledTools).toBeUndefined()
  })

  it('reconciles a plan after durable work however the reply is worded', async () => {
    const plan = {
      title: 'Fix the sandbox',
      steps: [{ id: 'step-1', title: 'Implement and verify', status: 'in_progress' as const }],
      updatedAt: 1
    }
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
      io.onActivity?.({
        id: 'edit-1',
        name: 'edit_file',
        kind: 'write',
        title: 'Edit index.html',
        status: 'success'
      })
      return Promise.resolve(
        result({ content: 'The edit is in place; I still need to verify it.' })
      )
    })
    mockedRunGeneration.mockResolvedValue(result({ content: '' }))

    await runBoundedChatGeneration(baseRequest({ prompt: 'continue the plan', plan }), baseIo())

    // Durable work plus an open plan row is the whole condition. This used to
    // additionally require the reply to *sound* finished, so a turn that did the
    // work and ended on an honest caveat — exactly this one — left its plan rows
    // stale in the user's dock. The reconciliation prompt itself still refuses to
    // tick a step the completed work does not support.
    // The work, one continuation the open plan earns, then the bookkeeping pass.
    expect(mockedRunGeneration).toHaveBeenCalledTimes(3)
    expect(mockedRunGeneration.mock.calls[2][1].enabledTools).toEqual(new Set(['update_plan_step']))
  })

  /**
   * The user's "Turn time limit" only ever reached `GenerationBudget`, which is
   * constructed inside `runGeneration` — so it bounded one cycle while the turn
   * itself was bounded only by `MAX_CYCLES`. At the default that is a setting
   * reading fifteen minutes and permitting six hours; measured turns ran 36 and
   * 50 minutes against a 40-minute limit.
   */
  describe('turn time limit', () => {
    /**
     * A cycle that stops recoverably, so the runner *wants* to continue, and
     * that does genuinely new work — the tool call and the prose both have to
     * differ every cycle or the cross-cycle no-progress guard ends the turn
     * first and the deadline is never what is being measured.
     */
    function recoverableCycle(elapsedMs: number): void {
      mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
        const n = mockedRunGeneration.mock.calls.length
        io.onActivity?.({
          id: `edit-${n}`,
          name: 'edit_file',
          kind: 'write',
          title: `Edit file-${n}.ts`,
          status: 'success',
          result: `Edited file-${n}.ts`
        })
        now += elapsedMs
        return Promise.resolve(
          result({
            content: `Partial work on file-${n}.`,
            stopped: true,
            stopReason: 'tool-limit',
            stats: { tokens: 5, durationMs: elapsedMs, tokensPerSecond: 1 }
          })
        )
      })
    }

    let now = 0
    beforeEach(() => {
      mockedRunGeneration.mockReset()
      now = 1_000_000
      vi.spyOn(Date, 'now').mockImplementation(() => now)
    })
    afterEach(() => vi.restoreAllMocks())

    it('stops taking cycles once the limit has passed', async () => {
      // Each cycle burns most of the 15-minute default, so the second one ends
      // past the deadline and no third may start.
      for (let i = 0; i < 5; i++) recoverableCycle(10 * 60_000)

      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

      expect(cycleCallCount()).toBe(2)
      expect(outcome.content).toContain('turn time limit')
    })

    /**
     * Observed live: a two-cycle turn whose second cycle ended on its round
     * budget, stopped by the turn deadline. The outcome block said so
     * correctly; the error banner above it announced the provider-round budget
     * instead, which was not why the turn ended and carried no advice.
     */
    it('reports the deadline as the reason, not whatever the last cycle hit', async () => {
      for (let i = 0; i < 5; i++) recoverableCycle(10 * 60_000)

      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

      expect(outcome.stopReason).toBeUndefined()
      expect(outcome.turnOutcome).toContain('turn time limit')
      expect(outcome.turnOutcome).toContain('continue')
    })

    it('never cuts a cycle short — the deadline only refuses the next one', async () => {
      // One cycle running long past the limit still returns its work intact.
      recoverableCycle(60 * 60_000)

      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

      expect(cycleCallCount()).toBe(1)
      expect(outcome.content).toContain('Partial work on file-')
    })

    it('keeps continuing when the user has set no limit', async () => {
      settings.generation.turnTimeLimitMinutes = null
      for (let i = 0; i < 4; i++) recoverableCycle(60 * 60_000)
      mockedRunGeneration.mockImplementationOnce(() =>
        Promise.resolve(result({ content: 'Finished.' }))
      )

      await runBoundedChatGeneration(baseRequest(), baseIo())

      // Hours of cycles, and the only thing that ended it was the work.
      expect(cycleCallCount()).toBeGreaterThan(2)
    })
  })

  /**
   * P3.1: a standing `/goal` turns the reply into a bounded goal run that keeps
   * taking cycles while real progress continues, instead of stopping after one.
   * The driving incident's user wrote "don't stop till its done and completely
   * working" and got a single turn.
   */
  describe('goal runs', () => {
    const goalRequest = (): ChatRequest => baseRequest({ goal: 'Fix the sandbox' })

    function cycle(calls: ToolCall[], content: string, stopped = false): void {
      mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
        for (const call of calls) io.onActivity?.(call)
        return Promise.resolve(
          result({
            content,
            stopped,
            stats: { tokens: 5, durationMs: 50, tokensPerSecond: 100 }
          })
        )
      })
    }

    const edit = (id: string): ToolCall => ({
      id,
      name: 'edit_file',
      kind: 'write',
      title: `Edit ${id}`,
      status: 'success'
    })
    const finish = (summary: string): ToolCall => ({
      id: 'finish-1',
      name: 'finish_goal',
      kind: 'plan',
      title: 'Finish goal',
      status: 'success',
      detail: summary
    })

    it('keeps taking cycles on a clean finish that did not call finish_goal', async () => {
      mockedRunGeneration.mockReset()
      cycle([edit('a')], 'Made a change.')
      cycle([edit('b')], 'Made another.')
      cycle([edit('c'), finish('Sandbox renders.')], 'Done.')

      const outcome = await runBoundedChatGeneration(goalRequest(), baseIo())

      expect(mockedRunGeneration).toHaveBeenCalledTimes(3)
      expect(outcome.goalOutcome).toEqual({ status: 'finished', summary: 'Sandbox renders.' })
    })

    it('does not continue an ordinary turn that has no goal', async () => {
      mockedRunGeneration.mockReset()
      cycle([edit('a')], 'Made a change.')

      await runBoundedChatGeneration(baseRequest(), baseIo())

      expect(mockedRunGeneration).toHaveBeenCalledOnce()
    })

    it('uses a goal-aware continuation prompt naming the goal and finish_goal', async () => {
      mockedRunGeneration.mockReset()
      cycle([edit('a')], 'Step one.')
      cycle([edit('b'), finish('Done.')], 'Finished.')

      await runBoundedChatGeneration(goalRequest(), baseIo())

      const continuation = mockedRunGeneration.mock.calls[1][0].prompt
      expect(continuation).toContain('Fix the sandbox')
      expect(continuation).toContain('finish_goal')
      expect(continuation).toContain('visual inspection')
    })

    /**
     * The caution recorded in the work log: a finish_goal REFUSAL from the
     * evidence gate arrives as an error, and must read as "go and verify it",
     * not as a terminal outcome. Treating it as terminal would turn a
     * recoverable correction into a dead run.
     */
    it('treats a refused finish_goal as a continue signal, not an ending', async () => {
      mockedRunGeneration.mockReset()
      const refused: ToolCall = {
        id: 'finish-refused',
        name: 'finish_goal',
        kind: 'plan',
        title: 'Finish goal',
        status: 'error',
        detail: 'no visual inspection has run since the last change'
      }
      cycle([edit('a'), refused], 'Tried to finish.')
      cycle([edit('b'), finish('Verified.')], 'Now done.')

      const outcome = await runBoundedChatGeneration(goalRequest(), baseIo())

      expect(mockedRunGeneration).toHaveBeenCalledTimes(2)
      expect(outcome.goalOutcome?.status).toBe('finished')
    })

    it('stops and reports unfinished when a cycle makes no progress', async () => {
      mockedRunGeneration.mockReset()
      cycle([edit('a')], 'Did something.')
      cycle([], '')

      const outcome = await runBoundedChatGeneration(goalRequest(), baseIo())

      expect(outcome.goalOutcome?.status).toBe('unfinished')
      expect(outcome.goalOutcome?.blockedReason).toContain('no new progress')
    })

    it('reports a user stop distinctly from running out of room', async () => {
      mockedRunGeneration.mockReset()
      cycle([edit('a')], 'Did something.')
      const controller = new AbortController()
      controller.abort()

      const outcome = await runBoundedChatGeneration(
        goalRequest(),
        baseIo({ signal: controller.signal })
      )

      expect(outcome.goalOutcome?.blockedReason).toBe('Stopped by you.')
    })
  })

  /**
   * Anodex is a general-purpose coding assistant. The build-verification note
   * used to recognize only JavaScript tooling plus a handful of others, so a
   * C++ developer whose `make test` passed, or a Ruby developer whose `rspec`
   * ran green, was told their verified fix was unverified — Anodex's own
   * honesty machinery producing a false accusation, for non-JS projects only.
   */
  describe('build verification across ecosystems', () => {
    async function replyAfter(command: string): Promise<string> {
      mockedRunGeneration.mockReset()
      mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
        // A change is what makes verification meaningful — the note is about an
        // unverified edit, not about an unverified sentence.
        io.onActivity?.({
          id: 'edit-1',
          name: 'edit_file',
          kind: 'write',
          title: 'Edit src/main.cpp',
          status: 'success'
        })
        io.onActivity?.({
          id: 'check-1',
          name: 'run_command',
          kind: 'command',
          title: `Run: ${command}`,
          status: 'success',
          detail: 'exit 0'
        })
        return Promise.resolve(
          result({
            content: 'The build failure is fixed and the test suite compiles.',
            stats: { tokens: 5, durationMs: 50, tokensPerSecond: 100 }
          })
        )
      })
      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())
      return outcome.content
    }

    it.each([
      ['C/C++ make', 'make test'],
      ['CMake/CTest', 'ctest --output-on-failure'],
      ['Ninja', 'ninja test'],
      ['Python ruff', 'ruff check .'],
      ['Python mypy', 'mypy .'],
      ['Swift', 'swift test'],
      ['Flutter', 'flutter test'],
      ['Xcode', 'xcodebuild test'],
      ['Ruby rake', 'rake test'],
      ['Ruby rspec', 'bundle exec rspec'],
      ['PHP', 'phpunit'],
      ['Deno', 'deno test'],
      ['Zig', 'zig build test'],
      ['MSBuild', 'msbuild /t:Build'],
      ['g++', 'g++ -c main.cpp'],
      ['Gradle', 'gradle test'],
      ['Cargo', 'cargo test']
    ])('accepts %s as real verification', async (_label, command) => {
      expect(await replyAfter(command)).not.toContain('Not verified')
    })

    it('still warns when nothing that verifies anything ran', async () => {
      expect(await replyAfter('ls -la')).toContain('Not verified')
    })
  })

  it('warns when a reply changed files and nothing was run against them', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
      io.onActivity?.({
        id: 'edit-1',
        name: 'edit_file',
        kind: 'write',
        title: 'Edit src/index.ts',
        status: 'success'
      })
      return Promise.resolve(result({ content: 'Restructured the entry point.' }))
    })

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    // Decided by the settled calls, not by whether the prose mentions a build.
    // The old wording gate stayed silent on the majority of unverified changes
    // and spoke up on diagnoses that had changed nothing at all.
    expect(outcome.content).toContain('Not verified')
    expect(outcome.content).toContain('Not verified')
  })

  it('stays quiet about verification for a reply that changed nothing', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockResolvedValueOnce(
      result({ content: 'Build issue: this structural change would make it run.' })
    )

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(outcome.content).not.toContain('Not verified')
  })

  it('does not warn when a build command actually completed', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
      io.onActivity?.({
        id: 'edit-1',
        name: 'edit_file',
        kind: 'write',
        title: 'Edit src/index.ts',
        status: 'success'
      })
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

    expect(outcome.content).not.toContain('Not verified')
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
    // A reply that inspected and changed nothing now says so — see
    // `describeNoDurableChange`.
    expect(outcome.content).toContain('Here is the audit.')
    expect(outcome.content).toContain('Changed** nothing')
  })

  it('does not treat a failed tool call as progress worth another recovery cycle', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
      io.onActivity?.({
        id: 'failed-read',
        name: 'read_file_range',
        kind: 'read',
        title: 'Read src/index.ts lines 1-200',
        status: 'error',
        detail: 'Already read earlier this task'
      })
      return Promise.resolve(result({ content: '', stopped: true, stopReason: 'context-limit' }))
    })

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledOnce()
    expect(outcome.stopReason).toBe('context-limit')
  })

  it('does not treat an explicitly no-op success as durable progress', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
      io.onActivity?.({
        id: 'covered-read',
        name: 'read_file_range',
        kind: 'read',
        title: 'Read src/index.ts lines 1-200',
        status: 'success',
        detail: 'Already read earlier this task',
        madeProgress: false
      })
      return Promise.resolve(result({ content: '', stopped: true, stopReason: 'context-limit' }))
    })

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledOnce()
    expect(outcome.stopReason).toBe('context-limit')
  })

  it('continues once when the transport handed over at a proactive checkpoint', async () => {
    // The driving failure: `read_email` on a bogus id was the cycle's only
    // activity, so it counted as no progress, and the transport had already
    // stopped itself with the result complete and room left for a reply. The
    // model never got the round in which it would have answered, and the user
    // was shown zero characters. Over the proactive limit by eighteen tokens.
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'bogus-read',
          name: 'read_email',
          kind: 'read',
          title: 'Read message BOGUS-MESSAGE-ID-99999',
          status: 'error',
          detail: 'No message with that id'
        })
        return Promise.resolve(
          result({
            content: '',
            stopped: true,
            stopReason: 'context-limit',
            contextEpochCause: 'proactive',
            contextBudget: budget(6_388)
          })
        )
      })
      .mockResolvedValueOnce(result({ content: 'There is no email with that id.' }))

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(cycleCallCount()).toBe(2)
    expect(mockedRunGeneration.mock.calls[1][0].contextEpoch?.epoch).toBe(1)
    expect(outcome.content).toContain('There is no email with that id.')
  })

  it('restates the user question when resuming after a context epoch', async () => {
    // An epoch resets history to the turns before this reply, which does not
    // contain this turn's prompt. Without restating it the last user message
    // the model sees is the PREVIOUS turn's question — a live 8K run resumed
    // answering "delete the oldest email" when asked to read a bogus id.
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'bogus-read',
          name: 'read_email',
          kind: 'read',
          title: 'Read message BOGUS-MESSAGE-ID-99999',
          status: 'error',
          detail: 'No message with that id'
        })
        return Promise.resolve(
          result({
            content: '',
            stopped: true,
            stopReason: 'context-limit',
            contextEpochCause: 'proactive',
            contextBudget: budget(6_388)
          })
        )
      })
      .mockResolvedValueOnce(result({ content: 'No such message.' }))

    await runBoundedChatGeneration(
      baseRequest({
        prompt: 'read BOGUS-MESSAGE-ID-99999',
        history: [
          { role: 'user', content: 'delete the oldest email in my inbox' },
          { role: 'assistant', content: 'I cannot delete mail.' }
        ]
      }),
      baseIo()
    )

    const resumed = mockedRunGeneration.mock.calls[1][0]
    expect(resumed.prompt).toContain('read BOGUS-MESSAGE-ID-99999')
    // The history it resumes on still ends with the previous turn, so the
    // restatement is the only thing naming the real question.
    expect(resumed.history.at(-1)?.content).toBe('I cannot delete mail.')
  })

  it('keeps an in-turn context stop terminal after a failed call', async () => {
    // The narrowness that makes the rescue above safe. `'in-turn'` means the
    // model did get its rounds and filled the window underneath itself, which
    // is the error/no-op loop the progress gate was built for.
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
      io.onActivity?.({
        id: 'failed-read',
        name: 'read_file_range',
        kind: 'read',
        title: 'Read src/index.ts lines 1-200',
        status: 'error',
        detail: 'Already read earlier this task'
      })
      return Promise.resolve(
        result({
          content: '',
          stopped: true,
          stopReason: 'context-limit',
          contextEpochCause: 'in-turn',
          contextBudget: budget(6_388)
        })
      )
    })

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(cycleCallCount()).toBe(1)
    expect(outcome.stopReason).toBe('context-limit')
  })

  it('spends the proactive checkpoint rescue only once in a turn', async () => {
    // A second progress-free checkpoint means compaction is not buying the
    // model anything, so the allowance is one per turn rather than per epoch.
    mockedRunGeneration.mockReset()
    const proactiveErrorCycle =
      (id: string) =>
      (_request: ChatRequest, io: RunGenerationIo): Promise<RunGenerationResult> => {
        io.onActivity?.({
          id,
          name: 'read_email',
          kind: 'read',
          title: `Read message ${id}`,
          status: 'error',
          detail: 'No message with that id'
        })
        return Promise.resolve(
          result({
            content: '',
            stopped: true,
            stopReason: 'context-limit',
            contextEpochCause: 'proactive',
            contextBudget: budget(6_388)
          })
        )
      }
    mockedRunGeneration
      .mockImplementationOnce(proactiveErrorCycle('bogus-1'))
      .mockImplementationOnce(proactiveErrorCycle('bogus-2'))
      .mockResolvedValueOnce(result({ content: 'Should never run.' }))

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(cycleCallCount()).toBe(2)
    expect(outcome.content).not.toContain('Should never run.')
  })

  it('starts one compact continuation after a loop guard when real work preceded it', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'write-1',
          name: 'write_file',
          kind: 'write',
          title: 'Write src/real.ts',
          status: 'success',
          touchedPaths: ['src/real.ts']
        })
        io.onActivity?.({
          id: 'repeat-1',
          name: 'read_file_range',
          kind: 'read',
          title: 'Read the same range again',
          status: 'error',
          detail: 'Blocked: repeated identical call'
        })
        return Promise.resolve(
          result({
            content: 'Implemented the first part.',
            stopped: true,
            stopReason: 'loop-guard'
          })
        )
      })
      .mockResolvedValueOnce(result({ content: 'Continued and verified the change.' }))

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledTimes(2)
    const handoff = mockedRunGeneration.mock.calls[1][0].contextEpoch
    expect(handoff?.cause).toBe('loop-guard')
    expect(handoff?.completedTools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'write_file', status: 'success' })])
    )
    expect(outcome.content).toContain('Continued and verified the change.')
  })

  it('keeps a loop guard terminal when the cycle only produced errors and prose', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
      io.onActivity?.({
        id: 'repeat-1',
        name: 'read_file_range',
        kind: 'read',
        title: 'Read the same range again',
        status: 'error',
        detail: 'Blocked: repeated identical call'
      })
      return Promise.resolve(
        result({ content: 'I am still investigating.', stopped: true, stopReason: 'loop-guard' })
      )
    })

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(cycleCallCount()).toBe(1)
    expect(outcome.stopReason).toBe('loop-guard')
  })

  it('passes a protected structured handoff into the next context-recovery cycle', async () => {
    const persistedHistory = [
      { role: 'user' as const, content: 'Earlier question.' },
      { role: 'assistant' as const, content: 'Earlier answer.' }
    ]
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'write-1',
          name: 'write_file',
          kind: 'write',
          title: 'Write src/recovered.ts',
          status: 'success',
          touchedPaths: ['src/recovered.ts']
        })
        return Promise.resolve(
          result({
            content: 'The first change is complete.',
            stopped: true,
            stopReason: 'context-limit',
            contextEpochCause: 'proactive'
          })
        )
      })
      .mockResolvedValueOnce(result({ content: 'Recovered and verified.' }))

    await runBoundedChatGeneration(baseRequest({ history: persistedHistory }), baseIo())

    const resumed = mockedRunGeneration.mock.calls[1][0]
    // The handoff is the compact replacement for this reply's tool transcript.
    // Replaying both would refill the new epoch with the evidence it just shed.
    expect(resumed.history).toEqual(persistedHistory)
    expect(resumed.contextEpoch).toMatchObject({
      version: 1,
      epoch: 1,
      cause: 'proactive',
      objective: 'audit the project',
      completedTools: [
        {
          name: 'write_file',
          status: 'success',
          touchedPaths: ['src/recovered.ts']
        }
      ]
    })
  })

  it('carries the objective, the model’s findings, and representative evidence into an epoch', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'visual-1',
          name: 'inspect_visual',
          kind: 'read',
          title: 'Inspect index.html',
          status: 'success',
          touchedPaths: ['index.html']
        })
        io.onActivity?.({
          id: 'index-1',
          name: 'read_file_range',
          kind: 'read',
          title: 'Read index.html lines 1-180',
          status: 'success',
          touchedPaths: ['index.html']
        })
        for (let index = 0; index < 5; index++) {
          io.onActivity?.({
            id: `sandbox-${index}`,
            name: 'read_file_range',
            kind: 'read',
            title: `Read js/universe-sandbox.js lines ${index * 100 + 1}-${index * 100 + 200}`,
            status: 'success',
            touchedPaths: ['js/universe-sandbox.js']
          })
        }
        return Promise.resolve(
          result({
            content:
              'The 2D canvas is visible, but the 3D sandbox and Planets section are blank.\n\n' +
              'I notice ambientLight is declared but never added to the scene. Let me check the rest of the file.\n\n' +
              'Let me resume the older orbit-line and texture tasks.',
            stopped: true,
            stopReason: 'context-limit',
            contextEpochCause: 'proactive'
          })
        )
      })
      .mockResolvedValueOnce(result({ content: 'Continued from the diagnosis.' }))

    await runBoundedChatGeneration(
      baseRequest({
        prompt: 'does not seem to be working',
        history: [
          { role: 'user', content: 'Start working on step 2 of the Universe Sandbox.' },
          { role: 'assistant', content: 'I started the implementation.' }
        ]
      }),
      baseIo()
    )

    const handoff = mockedRunGeneration.mock.calls[1][0].contextEpoch
    // The objective is the request as typed. It used to be rewritten to splice
    // in earlier user turns when the wording matched a "vague follow-up"
    // pattern, which made what a recovery resumed depend on phrasing; the prior
    // turns are still in the replayed history either way.
    expect(handoff?.objective).toBe('does not seem to be working')
    // Findings survive verbatim. Filtering "process narration" out of them by
    // phrase was dropped: it decided what a recovery remembered from wording,
    // and truncated paragraphs mid-sentence when a matched phrase followed a
    // real finding.
    expect(handoff?.workingSummary).toContain('3D sandbox and Planets section are blank')
    expect(handoff?.workingSummary).toContain('ambientLight is declared')
    expect(handoff?.completedTools.map((tool) => tool.name)).toContain('inspect_visual')
    expect(
      handoff?.completedTools.filter((tool) => tool.touchedPaths?.[0] === 'index.html')
    ).not.toHaveLength(0)
    expect(
      handoff?.completedTools.filter((tool) => tool.touchedPaths?.[0] === 'js/universe-sandbox.js')
    ).toHaveLength(1)
  })

  it('keeps durable work while aggressively shedding late error churn from the handoff', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        for (let index = 1; index <= 4; index++) {
          io.onActivity?.({
            id: `write-${index}`,
            name: 'write_file',
            kind: 'write',
            title: `Write src/part-${index}.ts`,
            status: 'success',
            touchedPaths: [`src/part-${index}.ts`]
          })
        }
        for (let index = 1; index <= 16; index++) {
          io.onActivity?.({
            id: `error-${index}`,
            name: 'read_file_range',
            kind: 'read',
            title: `Rejected repeat ${index}`,
            status: 'error',
            detail: 'Already read earlier this task'
          })
        }
        return Promise.resolve(
          result({
            content: 'The implementation is partially complete.',
            stopped: true,
            stopReason: 'context-limit'
          })
        )
      })
      .mockResolvedValueOnce(result({ content: 'Finished.' }))

    await runBoundedChatGeneration(baseRequest(), baseIo())

    const completed = mockedRunGeneration.mock.calls[1][0].contextEpoch?.completedTools ?? []
    expect(completed).toHaveLength(6)
    expect(completed.filter((call) => call.name === 'write_file')).toHaveLength(4)
    expect(completed.filter((call) => call.status === 'error')).toHaveLength(2)
  })

  it('continues beyond three context-recovery handoffs while progress remains bounded', async () => {
    mockedRunGeneration.mockReset()
    for (let cycle = 1; cycle <= 4; cycle++) {
      mockedRunGeneration.mockResolvedValueOnce(
        result({
          content: `Completed recovery cycle ${cycle}.`,
          stopped: true,
          stopReason: 'context-limit'
        })
      )
    }
    mockedRunGeneration.mockResolvedValueOnce(result({ content: 'Finished after recovery.' }))

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledTimes(5)
    expect(mockedRunGeneration.mock.calls[1][0].contextEpoch?.epoch).toBe(1)
    expect(mockedRunGeneration.mock.calls[2][0].contextEpoch?.epoch).toBe(2)
    expect(mockedRunGeneration.mock.calls[3][0].contextEpoch?.epoch).toBe(3)
    expect(mockedRunGeneration.mock.calls[4][0].contextEpoch?.epoch).toBe(4)
    expect(outcome.content).toContain('Finished after recovery.')
  })

  it('recovers when only a read-only tool was still running at the boundary', async () => {
    const activities: ToolCall[] = []
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'pending-read',
          name: 'run_command',
          kind: 'command',
          title: 'Run: powershell -Command "(Get-Content src/real.ts | Select-Object -First 200)"',
          status: 'running'
        })
        return Promise.resolve(
          result({
            content: 'The earlier reads found the likely cause.',
            stopped: true,
            stopReason: 'context-limit'
          })
        )
      })
      .mockResolvedValueOnce(result({ content: 'Recovered safely.' }))

    await runBoundedChatGeneration(
      baseRequest(),
      baseIo({ onActivity: (call) => activities.push(call) })
    )

    expect(mockedRunGeneration).toHaveBeenCalledTimes(2)
    expect(mockedRunGeneration.mock.calls[1][0].contextEpoch?.epoch).toBe(1)
    expect(activities.at(-1)).toMatchObject({
      id: 'pending-read',
      status: 'error',
      madeProgress: false,
      detail: 'Stopped before this read finished'
    })
  })

  it('does not checkpoint while a potentially mutating tool is still running', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
      io.onActivity?.({
        id: 'pending-write',
        name: 'edit_file',
        kind: 'write',
        title: 'Edit src/real.ts',
        status: 'running'
      })
      return Promise.resolve(
        result({ content: 'The edit started.', stopped: true, stopReason: 'context-limit' })
      )
    })

    await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(cycleCallCount()).toBe(1)
  })

  it('treats observational shell commands as reads in a compact handoff', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'write-1',
          name: 'edit_file',
          kind: 'write',
          title: 'Edit src/real.ts',
          status: 'success'
        })
        for (let index = 1; index <= 8; index++) {
          io.onActivity?.({
            id: `shell-read-${index}`,
            name: 'run_command',
            kind: 'command',
            title: `Run: powershell -NoProfile -Command "(Get-Content src/real.ts -TotalCount ${index})"`,
            detail: 'exit 0',
            status: 'success'
          })
        }
        return Promise.resolve(
          result({
            content: 'Inspected the edited file.',
            stopped: true,
            stopReason: 'context-limit'
          })
        )
      })
      .mockResolvedValueOnce(result({ content: 'Done.' }))

    await runBoundedChatGeneration(baseRequest(), baseIo())

    const handoff = mockedRunGeneration.mock.calls[1][0].contextEpoch
    expect(handoff?.completedTools.filter((call) => call.name === 'run_command')).toHaveLength(1)
    expect(handoff?.progress).toMatchObject({ madeChange: true, lastChangeAt: 1 })
  })

  it('drops a completed plan before starting a new request', async () => {
    const completedPlan = {
      title: 'Old task',
      steps: [{ id: 'old-1', title: 'Already done', status: 'completed' as const }],
      updatedAt: 1
    }
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockResolvedValueOnce(result({ content: 'Started the new request.' }))

    await runBoundedChatGeneration(baseRequest({ plan: completedPlan }), baseIo())

    expect(mockedRunGeneration.mock.calls[0][0].plan).toBeNull()
  })

  it('carries command identity, write hashes and progress ordering into the handoff', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'write-1',
          name: 'write_file',
          kind: 'write',
          title: 'Write src/real.ts',
          status: 'success',
          touchedPaths: ['src/real.ts'],
          diff: { path: 'src/real.ts', before: 'export {}', after: 'export const a = 1' }
        })
        io.onActivity?.({
          id: 'cmd-1',
          name: 'run_command',
          kind: 'command',
          title: 'Run: git commit -m "ship"',
          detail: 'exit 0',
          status: 'success'
        })
        return Promise.resolve(
          result({
            content: 'Committed the change.',
            stopped: true,
            stopReason: 'context-limit',
            contextEpochCause: 'proactive',
            contextBudget: budget(11_480)
          })
        )
      })
      .mockResolvedValueOnce(result({ content: 'Done.' }))

    await runBoundedChatGeneration(baseRequest(), baseIo())

    const handoff = mockedRunGeneration.mock.calls[1][0].contextEpoch
    // A resumed epoch that is only told "run_command succeeded" cannot tell a
    // completed `git commit` from a completed `ls`.
    expect(handoff?.completedTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'run_command',
          identity: 'Run: git commit -m "ship"',
          outcome: 'exit 0'
        }),
        expect.objectContaining({ name: 'write_file' })
      ])
    )
    // A digest of what the write actually left on disk, so a resumed epoch can
    // recognize its own completed work instead of redoing it.
    const write = handoff?.completedTools.find((tool) => tool.name === 'write_file')
    expect(write?.contentHash).toMatch(/^[0-9a-f]{12}$/)
    // Seeds `finish_goal`'s gate, so a task whose work completed in the previous
    // epoch is not told to mutate again to prove it happened.
    expect(handoff?.progress).toEqual({
      madeChange: true,
      completedCalls: 2,
      lastChangeAt: 2,
      lastVisualInspectionAt: null
    })
    expect(handoff?.priorFixedTokens).toBe(11_480)
    expect(handoff?.evidenceIndex).toBeDefined()
  })

  it('treats an authorized recovery read after an epoch as real progress', async () => {
    mockedRunGeneration.mockReset()
    const reread: ToolCall = {
      id: 'read-1',
      name: 'read_file',
      kind: 'read',
      title: 'Read src/real.ts',
      status: 'success',
      result: 'export {}',
      touchedPaths: ['src/real.ts']
    }
    mockedRunGeneration
      // The same read happens before the epoch...
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.(reread)
        return Promise.resolve(
          result({ content: 'Looked at it.', stopped: true, stopReason: 'context-limit' })
        )
      })
      // ...and again after it, which is exactly what the handoff asks for. Keyed
      // without the epoch this reads as "no novel tool activity" and ends the run.
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.(reread)
        return Promise.resolve(result({ content: 'Recovered the detail.' }))
      })
      // Repeating the same text is not novel, so the goal run winds down here.
      .mockResolvedValue(result({ content: 'Finished.' }))

    await runBoundedChatGeneration(baseRequest({ goal: 'finish the audit' }), baseIo())

    // The run reached a third cycle: the post-epoch re-read counted as progress
    // rather than ending the run on the very action the handoff asked for.
    expect(mockedRunGeneration.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(mockedRunGeneration.mock.calls[1][0].contextEpoch?.epoch).toBe(1)
  })

  it('stops with a recovery-churn reason when an epoch only ever re-reads', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
      io.onActivity?.({
        id: 'w',
        name: 'write_file',
        kind: 'write',
        title: 'Write src/real.ts',
        status: 'success'
      })
      io.onActivity?.({
        id: 'initial-read',
        name: 'read_file',
        kind: 'read',
        title: 'Read src/real.ts',
        status: 'success'
      })
      return Promise.resolve(
        result({ content: 'Changed it.', stopped: true, stopReason: 'context-limit' })
      )
    })
    // Every later cycle reopens the exact same evidence and says nothing new.
    for (let index = 0; index < 3; index++) {
      mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: `r${index}`,
          name: 'read_file',
          kind: 'read',
          title: 'Read src/real.ts',
          status: 'success'
        })
        return Promise.resolve(result({ content: '' }))
      })
    }

    const outcome = await runBoundedChatGeneration(
      baseRequest({ goal: 'finish the audit' }),
      baseIo()
    )

    expect(mockedRunGeneration.mock.calls.length).toBeLessThanOrEqual(3)
    expect(outcome.goalOutcome).toMatchObject({ status: 'unfinished' })
    expect(outcome.goalOutcome?.blockedReason).toMatch(/re-reading the same material/i)
  })

  it('allows new read evidence across recovery epochs without treating it as churn', async () => {
    mockedRunGeneration.mockReset()
    for (let cycle = 0; cycle < 3; cycle++) {
      mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: `read-${cycle}`,
          name: 'read_file_range',
          kind: 'read',
          title: `Read js/universe-sandbox.js lines ${cycle * 100 + 1}-${cycle * 100 + 100}`,
          status: 'success',
          touchedPaths: ['js/universe-sandbox.js']
        })
        return Promise.resolve(
          result({
            content: `Found new evidence in range ${cycle}.`,
            stopped: true,
            stopReason: 'context-limit',
            contextEpochCause: 'proactive'
          })
        )
      })
    }
    mockedRunGeneration.mockResolvedValueOnce(
      result({ content: 'Finished from the new evidence.' })
    )

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledTimes(4)
    expect(outcome.stopped).toBe(false)
    expect(outcome.content).toContain('Finished from the new evidence.')
  })

  it('recognizes differently-spelled shell reads of the same range as recovery churn', async () => {
    mockedRunGeneration.mockReset()
    const commands = [
      'Run: Get-Content js/universe-sandbox.js -TotalCount 100',
      'Run: powershell -Command "(Get-Content js/universe-sandbox.js | Select-Object -First 100) -join "`n""',
      'Run: powershell -Command "Get-Content js/universe-sandbox.js | Select-Object -First 100"',
      'Run: Get-Content js/universe-sandbox.js -TotalCount 100'
    ]
    for (const [cycle, title] of commands.entries()) {
      mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: `shell-read-${cycle}`,
          name: 'run_command',
          kind: 'command',
          title,
          status: 'success',
          madeProgress: false
        })
        return Promise.resolve(
          result({
            content: `Read spelling ${cycle}.`,
            stopped: true,
            stopReason: 'context-limit',
            contextEpochCause: 'proactive'
          })
        )
      })
    }

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(cycleCallCount()).toBe(3)
    expect(outcome.stopReason).toBe('no-progress')
  })

  it('does not let repetitive visible chatter carry read-only context recovery indefinitely', async () => {
    mockedRunGeneration.mockReset()
    for (let cycle = 0; cycle < 12; cycle++) {
      mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: `read-a-${cycle}`,
          name: 'read_file_range',
          kind: 'read',
          title: 'Read js/universe-sandbox.js lines 1-200',
          status: 'success',
          touchedPaths: ['js/universe-sandbox.js']
        })
        io.onActivity?.({
          id: `read-b-${cycle}`,
          name: 'read_file_range',
          kind: 'read',
          title: 'Read js/universe-sandbox.js lines 200-399',
          status: 'success',
          touchedPaths: ['js/universe-sandbox.js']
        })
        return Promise.resolve(
          result({
            content: `Let me check the current state of the files pass ${cycle}.`,
            stopped: true,
            stopReason: 'context-limit',
            contextEpochCause: 'proactive'
          })
        )
      })
    }

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    // The production incident reached epoch 13 because every filler sentence
    // was unique. One initial pass plus two bounded recovery passes is enough
    // to prove the model is reopening evidence instead of advancing.
    expect(cycleCallCount()).toBe(3)
    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('no-progress')
    expect(outcome.context?.latestEpochHandoff?.epoch).toBe(2)
  })

  it('continues read-only work after a recoverable stop without classifying the user wording', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'inspect-1',
          name: 'run_command',
          kind: 'command',
          title: 'Run: Get-Content js/universe-sandbox.js | Select-Object -First 100',
          status: 'success',
          madeProgress: false
        })
        return Promise.resolve(
          result({
            content: 'Let me examine the current code and find the problem.',
            stopped: true,
            stopReason: 'context-limit',
            contextEpochCause: 'proactive'
          })
        )
      })
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'edit-1',
          name: 'edit_file',
          kind: 'write',
          title: 'Edit js/universe-sandbox.js',
          status: 'success',
          touchedPaths: ['js/universe-sandbox.js']
        })
        return Promise.resolve(result({ content: 'Fixed the renderer and verified the page.' }))
      })

    const outcome = await runBoundedChatGeneration(
      baseRequest({
        prompt:
          'when opening the folder and running the index.html it does not show the sandbox its just black no planets or anything'
      }),
      baseIo()
    )

    expect(mockedRunGeneration).toHaveBeenCalledTimes(2)
    // Restated verbatim after the epoch — carried, never classified.
    expect(mockedRunGeneration.mock.calls[1][0].prompt).toContain(
      'when opening the folder and running the index.html'
    )
    expect(outcome.stopped).toBe(false)
    expect(outcome.content).toContain('Fixed the renderer')
  })

  it('does not turn a diagnosis-only project question into an action continuation', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
      io.onActivity?.({
        id: 'inspect-1',
        name: 'read_file',
        kind: 'read',
        title: 'Read js/universe-sandbox.js',
        status: 'success'
      })
      return Promise.resolve(
        result({ content: 'The renderer is black because initialization failed.' })
      )
    })

    const outcome = await runBoundedChatGeneration(
      baseRequest({ prompt: 'Why is the renderer black? Diagnose only; do not edit it.' }),
      baseIo()
    )

    expect(mockedRunGeneration).toHaveBeenCalledOnce()
    expect(outcome.content).toContain('because initialization failed')
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
    expect(cycleCallCount()).toBe(24)
    expect(outcome.stopped).toBe(true)
    // The last cycle's own reason ('tool-limit') is not why the turn ended --
    // the cycle ceiling is -- and the turn outcome says so with what to do
    // next. Reporting both printed two different reasons for one stop, the
    // wrong one as the headline. See `supersededStopReason`.
    expect(outcome.stopReason).toBeUndefined()
    expect(outcome.turnOutcome).toContain('tool-calling rounds for a single reply')
    expect(outcome.turnOutcome).toContain('continue')
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

    expect(cycleCallCount()).toBe(2)
    expect(outcome.stopReason).toBe('rounds-exhausted')
  })

  // A live run made 181 calls of which 86 were exact repeats — one command ten
  // times — and never stopped, because every context epoch handed the same call
  // a fresh activity key and it read as novel work. The epoch still buys one
  // authorized re-read; it does not buy unlimited ones.
  it('stops repeating a call that a new context epoch keeps making look novel', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementation((_request, io: RunGenerationIo) => {
      io.onActivity?.({
        id: 'same-read',
        name: 'read_file',
        kind: 'read',
        title: 'Read index.html',
        status: 'success',
        result: 'unchanged contents'
      })
      return Promise.resolve(
        result({
          content: 'Let me check the current state of index.html.',
          stopped: true,
          stopReason: 'context-limit',
          contextBudget: budget(9_000),
          stats: { tokens: 1, durationMs: 1, tokensPerSecond: 1 }
        })
      )
    })

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    // Original + the one epoch-authorized re-read, then it stops rather than
    // run the cycle ceiling out on the same read.
    expect(cycleCallCount()).toBe(REPEATED_CALL_ALLOWANCE + 1)
    expect(outcome.stopped).toBe(true)
  })

  it('closes out a cut-short reply with a tool-less summary pass', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementation((_request, io: RunGenerationIo) => {
      // The closing pass is the one with no tools; it must not be able to start
      // new work, and its prose becomes the end of the reply.
      if (io.enabledTools?.size === 0) {
        return Promise.resolve(
          result({ content: 'I removed the import map and the sandbox still renders black.' })
        )
      }
      io.onActivity?.({
        id: 'edit-1',
        name: 'edit_file',
        kind: 'write',
        title: 'Edit index.html',
        status: 'success'
      })
      return Promise.resolve(
        result({
          content: 'Let me fix that now:',
          stopped: true,
          stopReason: 'rounds-exhausted',
          stats: { tokens: 1, durationMs: 1, tokensPerSecond: 1 }
        })
      )
    })

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(outcome.content).toContain(
      'I removed the import map and the sandbox still renders black.'
    )
  })

  // The ending that actually reached users: nothing is `stopped`, no end reason
  // is recorded, and the inherited plan is already complete — so every existing
  // signal says "finished" while the reply stops on "Now let me inspect the
  // page…" followed by a command and silence.
  it('closes out a reply the model trailed off from after a tool call', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementation((_request, io: RunGenerationIo) => {
      if (io.enabledTools?.size === 0) {
        return Promise.resolve(result({ content: 'I fixed the OrbitControls reference.' }))
      }
      io.onActivity?.({
        id: 'open-1',
        name: 'run_command',
        kind: 'command',
        title: 'Run start index.html',
        status: 'success'
      })
      return Promise.resolve(
        result({
          content: 'Now let me inspect the page to see if the sandbox renders.',
          stopped: false,
          endedOnToolCall: true,
          stats: { tokens: 1, durationMs: 1, tokensPerSecond: 1 }
        })
      )
    })

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(cycleCallCount()).toBe(1)
    expect(outcome.content).toContain('I fixed the OrbitControls reference.')
  })

  it('leaves a cleanly finished reply alone rather than adding a second ending', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementation((_request, io: RunGenerationIo) => {
      if (io.enabledTools?.size === 0) {
        return Promise.resolve(result({ content: 'SHOULD NOT RUN' }))
      }
      io.onActivity?.({
        id: 'read-1',
        name: 'read_file',
        kind: 'read',
        title: 'Read index.html',
        status: 'success'
      })
      // The model answered and called nothing further: a real conclusion.
      return Promise.resolve(
        result({
          content: 'The sandbox is black because the import map is unused.',
          stopped: false,
          endedOnToolCall: false,
          stats: { tokens: 1, durationMs: 1, tokensPerSecond: 1 }
        })
      )
    })

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(outcome.content).not.toContain('SHOULD NOT RUN')
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
    expect(firstIo.ledger).toBeDefined()
    expect(secondIo.ledger).toBe(firstIo.ledger)
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
      expect(outcome.content).toContain('exist here')
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
        io.ledger?.reads?.recordRange(join(workspace, 'src', 'real.ts'), 1, 1)
        return Promise.resolve(
          result({
            content: 'See `src/real.ts` for details.',
            stats: { tokens: 5, durationMs: 50, tokensPerSecond: 100 }
          })
        )
      })

      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

      expect(outcome.content).toContain('See `src/real.ts` for details.')
      expect(outcome.content).not.toContain('exist here')
      expect(outcome.content).not.toContain('not verified')
    })
  })
})

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

/**
 * These pin the removal of the prose classifiers, not just their replacements.
 *
 * Anodex used to decide whether a plan was active, whether a bookkeeping pass
 * should run, whether a change was unverified, and whether a visual claim was
 * supported — all by matching the model's or the user's wording. Each is now
 * decided from settled tool calls, so the deciding question for every case
 * below is "does changing only the words change the outcome?" It must not.
 */
describe('orchestration does not read prose', () => {
  const editCall: ToolCall = {
    id: 'edit-1',
    name: 'edit_file',
    kind: 'write',
    title: 'Edit src/index.ts',
    status: 'success'
  }

  function replyOnce(content: string, calls: ToolCall[] = []): void {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
      for (const call of calls) io.onActivity?.(call)
      return Promise.resolve(result({ content }))
    })
  }

  it('appends the same verification note however the change is described', async () => {
    const phrasings = [
      'Done — fixed the build.',
      'Restructured the entry point.',
      'Här är ändringen.',
      ''
    ]

    for (const content of phrasings) {
      replyOnce(content, [editCall])
      const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())
      expect(outcome.content).toContain('Not verified')
    }
  })

  it('passes an unfinished plan whatever the user typed', async () => {
    const plan = {
      title: 'Fix the sandbox',
      steps: [{ id: 'step-1', title: 'Implement', status: 'in_progress' as const }],
      updatedAt: 1
    }

    for (const prompt of ['continue the plan', 'add a totally unrelated feature', 'hej']) {
      replyOnce('Looking into it.')
      await runBoundedChatGeneration(baseRequest({ prompt, plan }), baseIo())
      // It used to be withheld unless the wording matched a continuation
      // pattern, which made phrasing an implicit control channel and hid real
      // conversation state from the model on most turns.
      expect(mockedRunGeneration.mock.calls[0][0].plan).toEqual(plan)
    }
  })

  it('carries the objective through an epoch exactly as the user typed it', async () => {
    for (const prompt of ['still not working', 'implement the moon orbits']) {
      mockedRunGeneration.mockReset()
      mockedRunGeneration
        .mockImplementationOnce((_request, io: RunGenerationIo) => {
          io.onActivity?.(editCall)
          return Promise.resolve(
            result({
              content: 'Partial progress.',
              stopped: true,
              stopReason: 'context-limit',
              contextEpochCause: 'proactive'
            })
          )
        })
        .mockResolvedValueOnce(result({ content: 'Continued.' }))

      await runBoundedChatGeneration(baseRequest({ prompt }), baseIo())

      expect(mockedRunGeneration.mock.calls[1][0].contextEpoch?.objective).toBe(prompt)
    }
  })

  it('keeps the model’s own findings in a handoff without filtering narration', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.(editCall)
        return Promise.resolve(
          result({
            content: 'Let me check the config.\n\nThe loader path is wrong in vite.config.ts.',
            stopped: true,
            stopReason: 'context-limit',
            contextEpochCause: 'proactive'
          })
        )
      })
      .mockResolvedValueOnce(result({ content: 'Continued.' }))

    await runBoundedChatGeneration(baseRequest(), baseIo())

    // Stripping "process narration" by phrase used to truncate paragraphs
    // mid-sentence when a matched phrase followed a real finding, so the
    // finding is what has to survive — a little narration alongside it is
    // cheaper than losing the conclusion.
    const handoff = mockedRunGeneration.mock.calls[1][0].contextEpoch
    expect(handoff?.workingSummary).toContain('loader path is wrong')
  })
})

/**
 * The plainest gap in the system, found live: a turn read two files, wrote
 * "Let me check the rest of the planet creation and animation code", and ended.
 * Clean provider finish, no stop reason, no error, no summary, nothing written.
 * From the user's side it simply stopped, and Anodex said nothing about it.
 *
 * It reports rather than continuing, deliberately. Anodex cannot tell that turn
 * apart from a deliberate diagnosis — the only difference is the user's wording
 * — and continuing on a guess would risk editing a project the user asked not
 * to touch.
 */
describe('a reply that changed nothing says so', () => {
  const read: ToolCall = {
    id: 'read-1',
    name: 'read_file_range',
    kind: 'read',
    title: 'Read js/universe-sandbox.js lines 1-200',
    status: 'success'
  }

  function replyOnce(content: string, calls: ToolCall[]): void {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
      for (const call of calls) io.onActivity?.(call)
      return Promise.resolve(result({ content }))
    })
  }

  it('notes a turn that inspected and stopped without changing anything', async () => {
    replyOnce('Let me check the rest of the planet creation and animation code.', [read])

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(outcome.content).toContain('Changed** nothing')
  })

  it('says nothing when the reply actually changed something', async () => {
    replyOnce('Fixed the ambient light.', [
      read,
      {
        id: 'edit-1',
        name: 'replace_lines',
        kind: 'write',
        title: 'Replace js/universe-sandbox.js lines 48-54',
        status: 'success'
      }
    ])

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(outcome.content).not.toContain('Changed** nothing')
  })

  it('does not count a shell command that only looked at a file as a change', async () => {
    replyOnce('Checked the file.', [
      {
        id: 'cmd-1',
        name: 'run_command',
        kind: 'command',
        title: "Run: sed -n '40,50p' js/universe-sandbox.js",
        status: 'success'
      }
    ])

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(outcome.content).toContain('Changed** nothing')
  })

  it('stays quiet when the turn stopped for a reason the user already sees', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, io: RunGenerationIo) => {
      io.onActivity?.(read)
      // A stop the runner will not continue from, so the turn really ends here
      // — `time-limit` and friends are recoverable and would take another cycle.
      return Promise.resolve(
        result({ content: 'Partial.', stopped: true, stopReason: 'fixed-context-limit' })
      )
    })

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    // A stop reason renders its own banner, so the summary must not add a second
    // explanation of *why* it ended — but it still reports what the turn did.
    expect(outcome.content).toContain('What this reply did')
    expect(outcome.content).not.toContain('Ended early')
  })

  it('appends no turn account on the chat surface', async () => {
    // `describeTurnOutcome` is an account of *work*: what was changed, what was
    // run against it, what is still unverified. A conversation has no work to
    // account for, and rendering one anyway produced a real absurdity in a live
    // run — the user said "my name is Merlin", the model called remember_fact,
    // and the reply ended "Changed: Remember fact (2 edits) / Not verified — no
    // build, test, type-check or lint command ran against the change".
    //
    // remember_fact is a `write` kind, so it counts as a durable change; the
    // fix is not to reclassify it (it genuinely writes) but to stop billing a
    // chat turn as engineering work.
    replyOnce('Noted — Merlin it is.', [
      { id: 'c1', name: 'remember_fact', kind: 'write', status: 'success', title: 'Remember fact' }
    ])

    const outcome = await runBoundedChatGeneration(baseRequest(), {
      ...baseIo(),
      surface: 'chat'
    })

    expect(outcome.content).not.toContain('What this reply did')
    expect(outcome.content).not.toContain('Not verified')
  })

  it('still appends the turn account when no surface is given', async () => {
    // Agent runs, scheduled tasks and workspace chats all omit the surface and
    // must keep the account they have always had.
    replyOnce('Done.', [
      { id: 'c1', name: 'write_file', kind: 'write', status: 'success', title: 'a.js' }
    ])

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(outcome.content).toContain('What this reply did')
  })

  it('stays quiet for a reply that used no tools at all', async () => {
    replyOnce('Three.js renders to a canvas element.', [])

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(outcome.content).not.toContain('Changed** nothing')
  })
})

/**
 * The stall that survived every other fix.
 *
 * Four runs of one request ended the same way: the model announced its next
 * action ("Now let me read the specific sections I need to fix") and then
 * emitted a round with no tool call, which is what ends a provider loop. No
 * stop reason, no error — the reply simply stopped mid-investigation.
 *
 * Continuing on "ended cleanly and changed nothing" was tried and reverted: a
 * deliberate diagnosis is identical in that state, and only the user's wording
 * separates them. An unfinished **plan** is the difference. It is explicit,
 * user-visible state the model wrote itself, and a question never has one.
 */
describe('an open plan resumes a turn that stopped while still working', () => {
  const openPlan = {
    title: 'Fix Universe Sandbox',
    steps: [
      { id: 'step-1', title: 'Fix lighting', status: 'completed' as const },
      { id: 'step-2', title: 'Fix orbit lines', status: 'in_progress' as const }
    ],
    updatedAt: 1
  }

  const realWork: ToolCall = {
    id: 'read-1',
    name: 'read_file_range',
    kind: 'read',
    title: 'Read js/universe-sandbox.js lines 1-200',
    status: 'success'
  }

  function firstCycle(calls: ToolCall[], content: string): void {
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        for (const call of calls) io.onActivity?.(call)
        return Promise.resolve(result({ content }))
      })
      .mockResolvedValue(result({ content: '' }))
  }

  it('resumes when the turn stopped with plan steps still open', async () => {
    firstCycle([realWork], 'Now let me read the specific sections I need to fix.')

    await runBoundedChatGeneration(baseRequest({ plan: openPlan }), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledTimes(2)
    expect(mockedRunGeneration.mock.calls[1][0].prompt).toContain('Continue exactly where you left')
  })

  it('does not resume a turn with no plan at all', async () => {
    firstCycle([realWork], 'The renderer is black because initialization failed.')

    await runBoundedChatGeneration(baseRequest(), baseIo())

    // This is the diagnosis case, and it is why the plan is the gate: without
    // one there is no state saying the work is unfinished, and guessing from
    // the request's wording could edit a project the user asked not to touch.
    expect(mockedRunGeneration).toHaveBeenCalledOnce()
  })

  it('does not resume when every plan step is already complete', async () => {
    firstCycle([realWork], 'All done.')

    await runBoundedChatGeneration(
      baseRequest({
        plan: {
          ...openPlan,
          steps: openPlan.steps.map((step) => ({ ...step, status: 'completed' as const }))
        }
      }),
      baseIo()
    )

    expect(mockedRunGeneration).toHaveBeenCalledOnce()
  })

  it('does not resume a cycle whose only calls were plan bookkeeping', async () => {
    firstCycle(
      [
        {
          id: 'plan-1',
          name: 'update_plan_step',
          kind: 'plan',
          title: 'Update plan step 2',
          status: 'success'
        }
      ],
      'Marked step 2 in progress.'
    )

    await runBoundedChatGeneration(baseRequest({ plan: openPlan }), baseIo())

    // Ticking a row is not evidence that work is in flight, so resuming would
    // just amplify a turn that achieved nothing.
    expect(mockedRunGeneration).toHaveBeenCalledOnce()
  })

  it('does not resume a cycle whose only call was a redirect', async () => {
    firstCycle(
      [{ ...realWork, madeProgress: false, detail: 'Redirected to stored evidence' }],
      'Let me look again.'
    )

    await runBoundedChatGeneration(baseRequest({ plan: openPlan }), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledOnce()
  })

  it('stops resuming once the model stops calling tools', async () => {
    firstCycle([realWork], 'Now let me read the specific sections I need to fix.')

    await runBoundedChatGeneration(baseRequest({ plan: openPlan }), baseIo())

    // The bound that keeps a permanently-open plan from tripling every later
    // turn: a cycle that calls nothing ends the run, so a finished turn costs
    // exactly one extra round to say so.
    expect(mockedRunGeneration).toHaveBeenCalledTimes(2)
  })
})

/**
 * A guard that ends a turn silently is its own failure.
 *
 * A live run made 162 calls and six real edits, then had its last two calls
 * refused by the gathering ladder and simply ended — no stop reason, no error,
 * no summary. The guard behaved exactly as designed and the user saw a reply
 * that stopped for no stated reason.
 */
describe('a reply cut short by the gathering ladder says so', () => {
  const read: ToolCall = {
    id: 'read-1',
    name: 'read_file_range',
    kind: 'read',
    title: 'Read js/app.js lines 1-200',
    status: 'success'
  }

  function replyOnce(io: RunGenerationIo, calls: ToolCall[], content: string): void {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, generationIo: RunGenerationIo) => {
      // Drive the shared ledger the way the tool runners do, so the block is
      // recorded through the real path rather than stubbed.
      for (let i = 0; i < 40; i++) {
        generationIo.ledger?.recordOutcome({ kind: 'read', madeProgress: true })
      }
      generationIo.ledger?.reviewCall({
        name: 'search_files',
        kind: 'read',
        key: '{"pattern":"x"}',
        args: { pattern: 'x' }
      })
      for (const call of calls) generationIo.onActivity?.(call)
      return Promise.resolve(result({ content }))
    })
    void io
  }

  it('reports the refusal instead of ending in silence', async () => {
    const io = baseIo()
    replyOnce(io, [read], 'Looking at the sandbox setup.')

    const outcome = await runBoundedChatGeneration(baseRequest(), io)

    expect(outcome.content).toContain('Ended early')
    expect(outcome.content).toContain('continue')
  })

  it('stays quiet when nothing was refused', async () => {
    const io = baseIo()
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementationOnce((_request, generationIo: RunGenerationIo) => {
      generationIo.onActivity?.(read)
      return Promise.resolve(result({ content: 'Looked at it.' }))
    })

    const outcome = await runBoundedChatGeneration(baseRequest(), io)

    expect(outcome.content).not.toContain('Ended early')
  })
})
