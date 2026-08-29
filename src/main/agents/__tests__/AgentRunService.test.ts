import { describe, expect, it } from 'vitest'
import { activeElapsedMs, type AgentRun } from '@shared/agentRun.types'
import { budgetExceededReason } from '../agentBudgets'
import { buildRunEnabledTools, runPreflightReason, withSettledOutcome } from '../AgentRunService'

describe('buildRunEnabledTools', () => {
  it('always includes the always-on tools plus the user selection', () => {
    const tools = buildRunEnabledTools({ enabledTools: ['write_file'], requirePlan: false })

    expect(tools.has('write_file')).toBe(true)
    expect(tools.has('find_skill')).toBe(true)
    expect(tools.has('load_skill')).toBe(true)
    expect(tools.has('finish_goal')).toBe(true)
  })

  it('does not include update_plan_step when the run was not plan-reviewed', () => {
    const tools = buildRunEnabledTools({ enabledTools: ['write_file'], requirePlan: false })

    expect(tools.has('update_plan_step')).toBe(false)
  })

  it('includes update_plan_step whenever the run went through plan review', () => {
    const tools = buildRunEnabledTools({ enabledTools: [], requirePlan: true })

    expect(tools.has('update_plan_step')).toBe(true)
  })

  it('adds update_plan_step even when the editor default selection omits it', () => {
    // The editor's own default seed — see AgentRunEditor.tsx.
    const editorDefault = ['fetch_url', 'web_search']
    const tools = buildRunEnabledTools({ enabledTools: editorDefault, requirePlan: true })

    expect(tools.has('update_plan_step')).toBe(true)
    expect(tools.has('fetch_url')).toBe(true)
    expect(tools.has('web_search')).toBe(true)
  })
})

describe('runPreflightReason', () => {
  function baseRun(
    overrides: Partial<{
      limitsEnabled: boolean
      maxTurns: number
      maxTokens: number
      maxDurationMinutes: number
      createdAt: number
    }> = {}
  ) {
    return {
      limitsEnabled: true,
      maxTurns: 8,
      maxTokens: 50_000,
      maxDurationMinutes: 30,
      createdAt: Date.now(),
      ...overrides
    }
  }

  it('allows the first execution turn when there is budget left', () => {
    expect(runPreflightReason(baseRun(), 2, 1_000, 0)).toBeNull()
  })

  it('allows it exactly at the boundary — startTurn equal to maxTurns', () => {
    expect(runPreflightReason(baseRun({ maxTurns: 2 }), 2, 0, 0)).toBeNull()
  })

  it('never checks anything when limits are disabled', () => {
    const run = baseRun({ limitsEnabled: false, maxTurns: 1 })
    expect(runPreflightReason(run, 99, 999_999, 999_999_999)).toBeNull()
  })

  it('stops before the loop runs once when planning alone already used every turn', () => {
    // requirePlan: true, maxTurns: 1 — runPlanningPhase's one turn already
    // used the entire budget, so approvePlan's startTurn (turnsUsed + 1 = 2)
    // exceeds maxTurns before a single execution turn has run.
    const reason = runPreflightReason(baseRun({ maxTurns: 1 }), 2, 0, 0)

    expect(reason).toMatch(/already used during plan review/)
    expect(reason).toMatch(/before execution could start/)
  })

  it('stops before spending a full turn when planning already exhausted the token budget', () => {
    const reason = runPreflightReason(baseRun({ maxTokens: 1_000 }), 2, 1_000, 0)

    expect(reason).toMatch(/token budget of 1,000 reached/)
  })

  it('stops before spending a full turn when planning already exhausted the time budget', () => {
    const reason = runPreflightReason(baseRun({ maxDurationMinutes: 1 }), 2, 0, 61_000)

    expect(reason).toMatch(/1-minute time budget reached/)
  })

  it('checks the turn-count gap before the token/time budget', () => {
    // Both conditions are true here — the turn-specific message is the more
    // actionable one (raise the turn limit) since token/time exhaustion
    // during planning alone is comparatively rare and less specific.
    const run = baseRun({ maxTurns: 1, maxTokens: 100 })
    const reason = runPreflightReason(run, 2, 100, 0)

    expect(reason).toMatch(/already used during plan review/)
  })
})

describe('activeElapsedMs — what the duration budget is measured against', () => {
  function run(overrides: Partial<Pick<AgentRun, 'activeMs' | 'activeSinceAt'>> = {}) {
    return { activeMs: 0, activeSinceAt: null, ...overrides }
  }

  it('reports only what has been banked while the run is idle', () => {
    expect(activeElapsedMs(run({ activeMs: 90_000 }), 5_000_000)).toBe(90_000)
  })

  it('adds the segment currently in flight', () => {
    expect(activeElapsedMs(run({ activeMs: 60_000, activeSinceAt: 1_000 }), 31_000)).toBe(90_000)
  })

  /**
   * The regression this field exists for. `requirePlan` defaults to true, so
   * the default run plans, then parks in `needs-review` until a human looks at
   * it. The budget used to be `now - createdAt`, which charged that wait to the
   * work budget: approve after lunch and the run stopped on arrival, having
   * executed nothing, blaming a time budget the user's own deliberation spent.
   */
  it('does not charge time spent parked in needs-review', () => {
    const createdAt = 0
    // Two minutes of planning, then an hour sitting unapproved.
    const parked = run({ activeMs: 120_000, activeSinceAt: null })
    const approvedAt = createdAt + 62 * 60_000

    expect(activeElapsedMs(parked, approvedAt)).toBe(120_000)
    // What the old measurement would have produced, against a 30-minute budget.
    expect(approvedAt - createdAt).toBeGreaterThan(30 * 60_000)
    expect(
      budgetExceededReason(
        { maxTokens: 50_000, maxDurationMinutes: 30, createdAt },
        0,
        activeElapsedMs(parked, approvedAt)
      )
    ).toBeNull()
    expect(
      budgetExceededReason(
        { maxTokens: 50_000, maxDurationMinutes: 30, createdAt },
        0,
        approvedAt - createdAt
      )
    ).toContain('30-minute time budget')
  })

  it('still stops a run that really has worked past its budget', () => {
    const worked = run({ activeMs: 31 * 60_000 })
    expect(
      budgetExceededReason(
        { maxTokens: 50_000, maxDurationMinutes: 30, createdAt: 0 },
        0,
        activeElapsedMs(worked, 0)
      )
    ).toContain('30-minute time budget')
  })

  it('treats a run persisted before these fields existed as having worked nothing', () => {
    const legacy = { activeMs: undefined, activeSinceAt: undefined } as unknown as AgentRun
    expect(activeElapsedMs(legacy, 5_000_000)).toBe(0)
  })
})

describe('withSettledOutcome', () => {
  it('keeps the settled record beside a claim of success', () => {
    // The measured failure: a run edited ui.py, ran the smoke test twice, got
    // exit 1 both times, said so in its own reply, then finished with "I've
    // completed the implementation". The factual account of that turn was
    // discarded in favour of the claim, and the workspace was left broken.
    const claim = "I've completed the implementation of camera bookmarks."
    const settled = '- **Ran** `python _smoke_test.py` exit 1'

    const joined = withSettledOutcome(claim, settled)

    expect(joined).toContain("I've completed the implementation")
    expect(joined).toContain('exit 1')
  })

  it('does not repeat an account the summary already carries', () => {
    const settled = '- **Changed** `camera.py`'
    expect(withSettledOutcome(`Done. ${settled}`, settled)).toBe(`Done. ${settled}`)
  })

  it('leaves an honest summary alone when there is no account to add', () => {
    expect(withSettledOutcome('Finished cleanly.', null)).toBe('Finished cleanly.')
    expect(withSettledOutcome('Finished cleanly.', '   ')).toBe('Finished cleanly.')
  })

  it('falls back to the account when the model wrote no summary', () => {
    expect(withSettledOutcome(null, '- **Changed** nothing')).toBe('- **Changed** nothing')
  })
})
