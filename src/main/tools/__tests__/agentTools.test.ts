import { describe, expect, it } from 'vitest'
import { finishGoalTool } from '../agentTools'
import { runGuardedTool, runReadTool } from '../helpers'
import type { ToolRuntimeContext } from '../types'
import { createMockContext, createMockDefine, captureCalls } from './test-helpers'
import { recordCompletedCall } from '../turnProgress'

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

  it('truncates a very long summary', async () => {
    const { calls, emit } = captureCalls()
    const ctx = { ...context(), emit }
    ctx.progress.madeChange = true
    const tool = finishGoalTool(createMockDefine(), ctx) as unknown as {
      handler: FinishGoalHandler
    }

    await tool.handler({ summary: 'a'.repeat(2000) })

    const finalCall = calls[calls.length - 1]
    expect(finalCall.status).toBe('success')
    expect(finalCall.detail!.length).toBeLessThan(1001)
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
  function withPlan(statuses: ReadonlyArray<'pending' | 'in_progress' | 'completed'>) {
    const ctx = context()
    ctx.progress.madeChange = true
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
   */
  it('lets the second call through, so the prompt cannot be worded around', async () => {
    const tool = withPlan(['completed', 'pending', 'pending'])
    const claim = {
      summary: 'The goal is complete. I completed the two remaining verification tasks.'
    }

    const refused = await tool.handler(claim)
    expect(refused).toContain('Error')
    expect(refused).toContain('2 step(s)')

    const second = await tool.handler(claim)
    expect(second).toContain('Run finished.')
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
