import { describe, expect, it } from 'vitest'
import { buildRunEnabledTools, runPreflightReason } from '../AgentRunService'

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
