import { describe, expect, it } from 'vitest'
import { finishGoalTool } from '../agentTools'
import { runGuardedTool, runReadTool } from '../helpers'
import type { ToolCall } from '@shared/tools.types'
import type { ToolRuntimeContext } from '../types'
import { createMockContext, createMockDefine, captureCalls } from './test-helpers'
import { createTaskLedger } from '../taskLedger'
import { createTurnProgress, priorTaskProgress, recordCompletedCall } from '../turnProgress'

type FinishGoalHandler = (args: { summary: string }) => Promise<string>

function context(): ToolRuntimeContext {
  return createMockContext('/tmp/workspace')
}

describe('finish_goal', () => {
  it('reports the summary back to the model when a real action succeeded this turn', async () => {
    const ctx = context()
    ctx.progress.madeChange = true
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    const result = await tool.handler({ summary: 'Found the answer and reported it.' })

    expect(result).toContain('Run finished.')
  })

  it('rejects an empty summary', async () => {
    const ctx = context()
    ctx.progress.madeChange = true
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    const result = await tool.handler({ summary: '   ' })

    expect(result).toContain('Error')
    expect(result).toContain('summary was empty')
  })

  it('truncates a very long summary, and says that it did', async () => {
    // A summary cut mid-word with a bare ellipsis reads as a model that lost
    // its thread. It matters here because the open-steps guard requires the
    // summary to name what was left undone, and a silent cut can remove exactly
    // that.
    const { calls, emit } = captureCalls()
    const ctx = { ...context(), emit }
    ctx.progress.madeChange = true
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    await tool.handler({ summary: 'a'.repeat(9000) })

    const finalCall = calls[calls.length - 1]
    expect(finalCall.status).toBe('success')
    expect(finalCall.detail!.length).toBeLessThanOrEqual(4000)
    expect(finalCall.detail).toContain('cut off by Anodex')
  })

  it('gives a real multi-step account room to name what it left undone', async () => {
    // The measured failure: a run finished with 4 of 7 steps open and wrote a
    // careful account of both halves. It was cut at 1,000 characters after item
    // 5, so the steps it abandoned were never named.
    const { calls, emit } = captureCalls()
    const ctx = { ...context(), emit }
    ctx.progress.madeChange = true
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }
    const account = `${'Completed the parser and the renderer. '.repeat(30)}Left undone: the UI toggle, because the toolbar refactor is not finished.`

    await tool.handler({ summary: account })

    const finalCall = calls[calls.length - 1]
    expect(finalCall.detail).toContain('Left undone: the UI toggle')
  })

  it('refuses to report success when no other tool call has succeeded this turn', async () => {
    const { calls, emit } = captureCalls()
    const ctx = { ...context(), emit }
    // ctx.progress.madeChange defaults to false — nothing has happened yet.
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    const result = await tool.handler({ summary: 'Created hello2.txt containing "hello".' })

    expect(result).toContain('Error')
    expect(result).toContain('cannot be accepted')
    const finalCall = calls[calls.length - 1]
    expect(finalCall.status).toBe('error')
  })

  it('accepts success once a non-read tool call has succeeded this turn, even after an earlier refusal', async () => {
    const { calls, emit } = captureCalls()
    const ctx = { ...context(), emit }
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    const firstAttempt = await tool.handler({ summary: 'Created hello2.txt.' })
    expect(firstAttempt).toContain('Error')

    // Simulate write_file (or any other non-read tool) succeeding afterward.
    ctx.progress.madeChange = true

    const secondAttempt = await tool.handler({ summary: 'Created hello2.txt.' })
    expect(secondAttempt).toContain('Run finished.')
    expect(calls[calls.length - 1].status).toBe('success')
  })

  it('does not treat a read-only tool call as satisfying the progress check', async () => {
    const ctx = context()
    // A read tool succeeding must not, by itself, count as progress.
    ctx.progress.madeChange = false
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    const result = await tool.handler({ summary: 'Read the file and confirmed its contents.' })

    expect(result).toContain('Error')
  })
})

describe('finish_goal — planning is not doing', () => {
  it('refuses a run that only wrote and ticked its own plan', async () => {
    // The failure this closes: a run writes a plan, marks a step done, and
    // declares the goal complete without ever touching a file. Anodex's whole
    // point is that an agent plans *and* carries the work out.
    const ctx = context()
    await runReadTool(ctx, {
      name: 'write_plan',
      kind: 'plan',
      title: 'Write plan',
      run: () => Promise.resolve({ modelResult: 'ok' })
    })
    await runReadTool(ctx, {
      name: 'update_plan_step',
      kind: 'plan',
      title: 'Update plan step',
      run: () => Promise.resolve({ modelResult: 'ok' })
    })
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    const result = await tool.handler({ summary: 'Built the feature as planned.' })

    expect(result).toContain('Error')
    expect(result).toContain('cannot be accepted')
  })

  it('says plainly that reading and planning do not count', async () => {
    // The model reads this refusal as its next instruction, so it has to name
    // what is missing rather than leave it to be guessed at.
    const ctx = context()
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    const result = await tool.handler({ summary: 'Done.' })

    expect(result).toMatch(/plan/i)
    expect(result).toMatch(/do not count|does not count/i)
  })

  it('accepts the finish once the planned work is actually carried out', async () => {
    const ctx = context()
    await runReadTool(ctx, {
      name: 'write_plan',
      kind: 'plan',
      title: 'Write plan',
      run: () => Promise.resolve({ modelResult: 'ok' })
    })
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }
    expect(await tool.handler({ summary: 'Planned it.' })).toContain('Error')

    await runGuardedTool(
      { ...ctx, permissionMode: 'untethered' as const },
      {
        name: 'write_file',
        kind: 'write',
        title: 'Write file',
        confirmDetail: 'src/feature.ts',
        risk: 'safe',
        run: () => Promise.resolve({ modelResult: 'ok' })
      }
    )

    expect(await tool.handler({ summary: 'Built the feature.' })).toContain('Run finished.')
  })
})

/**
 * A run summary asserting that something now renders is a claim about pixels,
 * and only a screenshot taken after the last change can support it. In chat
 * `c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef` an inspection ran at the very start
 * of the turn, the file was edited afterwards, and success was reported off
 * the stale screenshot.
 */
describe('finish_goal — visual claims need post-change evidence', () => {
  function finishGoal(ctx: ReturnType<typeof context>): {
    handler: (args: { summary: string }) => Promise<string>
  } {
    return finishGoalTool(createMockDefine(), ctx)
  }

  it('refuses when the only inspection preceded the last edit', async () => {
    const ctx = context()
    recordCompletedCall(ctx.progress, { name: 'inspect_visual', kind: 'read' })
    recordCompletedCall(ctx.progress, { name: 'edit_file', kind: 'write' })

    const result = await finishGoal(ctx).handler({
      summary: 'Fixed the sandbox — the canvas now renders correctly.'
    })

    expect(result).toContain('came after the most recent visual inspection')
    expect(result).toContain('inspect_visual')
  })

  it('accepts when an inspection followed the last edit', async () => {
    const ctx = context()
    recordCompletedCall(ctx.progress, { name: 'edit_file', kind: 'write' })
    recordCompletedCall(ctx.progress, { name: 'inspect_visual', kind: 'read' })

    const result = await finishGoal(ctx).handler({
      summary: 'Fixed the sandbox — the canvas now renders correctly.'
    })

    expect(result).toContain('Run finished')
  })

  it('accepts a non-visual completion claim without any inspection', async () => {
    const ctx = context()
    recordCompletedCall(ctx.progress, { name: 'edit_file', kind: 'write' })

    const result = await finishGoal(ctx).handler({
      summary: 'Renamed the helper and updated its call sites.'
    })

    expect(result).toContain('Run finished')
  })

  it('accepts an honest report that it could not be verified', async () => {
    const ctx = context()
    recordCompletedCall(ctx.progress, { name: 'edit_file', kind: 'write' })

    const result = await finishGoal(ctx).handler({
      summary: 'Changed the canvas setup, but this is unverified — I could not confirm it renders.'
    })

    expect(result).toContain('Run finished')
  })
})

/**
 * A run wrote a three-step plan, landed none of them, and called finish_goal at
 * turn 5 of 44 with a summary that said in its own words it had stopped
 * mid-diagnosis. Both existing guards passed it: real work had happened, and
 * the last change did precede the last visual inspection.
 */
describe('finish_goal and an unfinished plan', () => {
  function withPlan(
    statuses: ReadonlyArray<'pending' | 'in_progress' | 'completed'>,
    ledger?: ToolRuntimeContext['ledger']
  ) {
    const ctx = context()
    ctx.progress.madeChange = true
    if (ledger) ctx.ledger = ledger
    ctx.plan.current = {
      title: 'Visual quality',
      updatedAt: 1,
      steps: statuses.map((status, index) => ({
        id: String(index),
        title: ['Star corona', 'Procedural surfaces', 'HUD in headless render'][index] ?? 'Step',
        status
      }))
    }
    return finishGoalTool(createMockDefine(), ctx) as unknown as { handler: FinishGoalHandler }
  }

  it('refuses a completion claim while plan steps are still open', async () => {
    const tool = withPlan(['pending', 'pending', 'pending'])

    const result = await tool.handler({
      summary: 'Build, --check and --out all verified passing; corona code verified correct.'
    })

    expect(result).toContain('Error')
    expect(result).toContain('3 step(s)')
    expect(result).toContain('Star corona')
  })

  /**
   * Refused once, then the decision is the model's. Two attempts at reading the
   * summary both failed -- "the two remaining verification tasks" satisfied a
   * phrase check while claiming completion, and "corona code verified correct"
   * satisfied a name check for an open step called "Star corona". Naming a step
   * while claiming it works is not separable by keyword from naming it while
   * admitting it does not.
   *
   * That is unchanged: this summary is one that defeated both checks, and it is
   * still accepted without any inspection of its wording. What moved is *when* —
   * the second call has to come from a later turn, because a repeat inside the
   * same batch was written before the refusal existed and cannot be a
   * reconsideration of it.
   */
  it('lets a later turn through, so the prompt cannot be worded around', async () => {
    const ledger = createTaskLedger()
    const claim = {
      summary: 'The goal is complete. I completed the two remaining verification tasks.'
    }

    const refused = await withPlan(['completed', 'pending', 'pending'], ledger).handler(claim)
    expect(refused).toContain('Error')
    expect(refused).toContain('2 step(s)')

    const nextTurn = await withPlan(['completed', 'pending', 'pending'], ledger).handler(claim)
    expect(nextTurn).toContain('Run finished.')
  })

  it('accepts it when every step is complete', async () => {
    const tool = withPlan(['completed', 'completed', 'completed'])

    const result = await tool.handler({ summary: 'All three landed and verified.' })

    expect(result).toContain('Run finished.')
  })

  /** A run with no plan is unaffected — most runs never write one. */
  it('says nothing about a run that never wrote a plan', async () => {
    const ctx = context()
    ctx.progress.madeChange = true
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    const result = await tool.handler({ summary: 'Did the thing.' })

    expect(result).toContain('Run finished.')
  })
})

describe("finish_goal across an agent run's turns", () => {
  // `AgentRunService` calls `runGeneration` once per turn, so each turn builds a
  // fresh `TurnProgress`. These exercise the composition `runGeneration` now
  // performs: seed the turn from what earlier turns actually did.
  function turnAfter(history: { toolCalls?: ToolCall[] }[]): ToolRuntimeContext {
    const ctx = context()
    ctx.progress = createTurnProgress(priorTaskProgress(history))
    return ctx
  }

  const wroteAFile: { toolCalls?: ToolCall[] }[] = [
    {
      toolCalls: [
        { id: '1', name: 'write_file', kind: 'write', title: 'Write main.cpp', status: 'success' }
      ]
    }
  ]

  it('accepts a completion whose work landed in an earlier turn', async () => {
    // The measured failure: a run wrote files in turn 3, was asked by
    // CONTINUE_PROMPT to finish in turn 4, and was told to "create or edit a
    // file, run a command" — work it had already done.
    const ctx = turnAfter(wroteAFile)
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    const result = await tool.handler({ summary: 'Built and verified the renderer.' })

    expect(result).toContain('Run finished.')
  })

  it('still refuses a completion claim on a task where nothing was ever done', async () => {
    // The bar the original guard set, unchanged: observed live, a local model
    // claimed "Created hello2.txt" three turns running without ever calling
    // write_file. Reading and planning must still not satisfy it.
    const ctx = turnAfter([
      {
        toolCalls: [
          { id: '1', name: 'read_file', kind: 'read', title: 'Read main.cpp', status: 'success' },
          { id: '2', name: 'write_plan', kind: 'plan', title: 'Plan: fix', status: 'success' }
        ]
      }
    ])
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    const result = await tool.handler({ summary: 'Created hello2.txt.' })

    expect(result).toContain('Error')
    expect(result).toContain('Nothing has been done yet this turn')
  })

  it('still refuses on a task whose only earlier attempt failed', async () => {
    const ctx = turnAfter([
      {
        toolCalls: [
          { id: '1', name: 'write_file', kind: 'write', title: 'Write x', status: 'error' }
        ]
      }
    ])
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    expect(await tool.handler({ summary: 'Wrote the file.' })).toContain('Error')
  })
})

describe('finish_goal reconsideration spans a turn, not a batch', () => {
  // A model emits several tool calls in one response, all written before any of
  // their results come back. A second finish_goal sitting in that same batch is
  // therefore a sibling of the refused one, not a reconsideration of it.
  function planned(ledger: ToolRuntimeContext['ledger']): ToolRuntimeContext {
    const ctx = context()
    ctx.progress.madeChange = true
    ctx.ledger = ledger
    ctx.plan.current = {
      title: 'Palette',
      steps: [
        { id: 'a', title: 'Survey the colour literals', status: 'completed' },
        { id: 'b', title: 'Create palette.py', status: 'pending' },
        { id: 'c', title: 'Replace the literals', status: 'pending' }
      ],
      updatedAt: 0
    }
    return ctx
  }

  function tool(ctx: ToolRuntimeContext) {
    return finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }
  }

  it('refuses the first call and names the open steps', async () => {
    const ctx = planned(createTaskLedger())

    const result = await tool(ctx).handler({ summary: 'All done.' })

    expect(result).toContain('Error')
    expect(result).toContain('2 step(s) that are not complete')
    expect(result).toContain('Create palette.py')
  })

  it('refuses a repeat from the same turn, which cannot have seen the refusal', async () => {
    // The measured failure: a run was refused, said in its own reply "I
    // accidentally called finish_goal", carried on working, and then had four
    // more calls from the same batch accepted — ending at 1 of 8 steps with 12
    // turns unspent.
    const ctx = planned(createTaskLedger())
    await tool(ctx).handler({ summary: 'All done.' })

    const second = await tool(ctx).handler({ summary: 'All done.' })

    expect(second).toContain('Error')
    expect(second).toContain('already told this turn')
    expect(second).not.toContain('Run finished.')
  })

  it("accepts it on the next turn, so stopping early stays the run's own call", async () => {
    // The bar this must not raise: a run that genuinely means to stop early is
    // still allowed to, it just has to say so once its previous turn came back.
    const ledger = createTaskLedger()
    const firstTurn = planned(ledger)
    await tool(firstTurn).handler({ summary: 'All done.' })

    const nextTurn = planned(ledger)
    const result = await tool(nextTurn).handler({
      summary: 'Stopping: palette.py is written but the replacements are not done.'
    })

    expect(result).toContain('Run finished.')
  })

  it('never asks twice when the plan is actually finished', async () => {
    const ctx = planned(createTaskLedger())
    for (const step of ctx.plan.current!.steps) step.status = 'completed'

    const result = await tool(ctx).handler({ summary: 'Everything done.' })

    expect(result).toContain('Run finished.')
  })

  it('leaves a run with no plan alone entirely', async () => {
    const ctx = context()
    ctx.progress.madeChange = true
    ctx.plan.current = null

    const result = await tool(ctx).handler({ summary: 'Done, no plan was used.' })

    expect(result).toContain('Run finished.')
  })
})

describe('the open-steps prompt offers the option the model actually needs', () => {
  function plannedRun(): ToolRuntimeContext {
    const ctx = context()
    ctx.progress.madeChange = true
    ctx.plan.current = {
      title: 'Status bar',
      steps: [
        { id: 'a', title: 'Draw the bar', status: 'completed' },
        { id: 'b', title: 'Report the exit code and delete temporary scripts', status: 'pending' }
      ],
      updatedAt: 0
    }
    return ctx
  }

  it('tells a model that already did the work to mark it, not redo it', async () => {
    // Measured across 13 runs on the current build: the final plan step was
    // never once attempted with update_plan_step. In at least three the work
    // was demonstrably done — one ran the smoke test, reported the exit code
    // and deleted its temporary scripts, which was verbatim what its unmarked
    // final step asked for. The guard fires at exactly the right moment and
    // offered only "finish them" or "say what you left undone", so a model that
    // had finished read it as a demand for more work.
    const ctx = plannedRun()
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    const result = await tool.handler({ summary: 'Status bar done.' })

    expect(result).toContain('update_plan_step')
    expect(result).toContain('Report the exit code')
  })

  it('still lets a run stop early after being told', async () => {
    // The bar this must not raise: the decision stays the model's, and the
    // summary is still never parsed.
    const ledger = createTaskLedger()
    const first = plannedRun()
    first.ledger = ledger
    await (
      finishGoalTool(createMockDefine(), first) as unknown as { handler: FinishGoalHandler }
    ).handler({ summary: 'Stopping.' })

    const next = plannedRun()
    next.ledger = ledger
    const result = await (
      finishGoalTool(createMockDefine(), next) as unknown as { handler: FinishGoalHandler }
    ).handler({ summary: 'Stopping: the last step is not worth doing.' })

    expect(result).toContain('Run finished.')
  })

  it('says nothing when the plan is already complete', async () => {
    const ctx = plannedRun()
    for (const step of ctx.plan.current!.steps) step.status = 'completed'
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    expect(await tool.handler({ summary: 'All done.' })).toContain('Run finished.')
  })
})

describe('finish_goal called more than once in a turn', () => {
  // A run called finish_goal three times in one turn and was told "Run
  // finished." each time. The run does end - the turn loop inspects settled
  // calls afterwards, which is why this tool deliberately has no abort plumbing
  // - but the repeated identical answer teaches the model nothing and spends
  // two more calls.
  it('tells the model the run is already finishing', async () => {
    const ctx = context()
    ctx.progress.madeChange = true
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: (args: unknown) => Promise<string>
    }

    const first = await tool.handler({ summary: 'Added the helper and ran the tests.' })
    const second = await tool.handler({ summary: 'Added the helper and ran the tests.' })

    expect(first).toContain('Run finished')
    expect(second.toLowerCase()).toContain('already finishing')
  })
})
