import { describe, expect, it } from 'vitest'
import {
  MAX_SUB_AGENTS,
  MAX_TASK_LENGTH,
  renderReports,
  splitRunBudget,
  subAgentName,
  subAgentTools,
  validateDelegation,
  type SubAgentReport
} from '../subAgents'

describe('validateDelegation', () => {
  it('accepts a normal fan-out', () => {
    expect(validateDelegation(['check auth', 'check parsing'])).toEqual({
      tasks: ['check auth', 'check parsing']
    })
  })

  it('refuses a request that is not a list', () => {
    // A model that passes a bare string means one task, but guessing that is
    // how you get a sub-agent told to do the letter "c".
    expect(validateDelegation('check auth')).toHaveProperty('error')
    expect(validateDelegation(undefined)).toHaveProperty('error')
  })

  it('drops blank entries rather than starting an agent with nothing to do', () => {
    // A blank task burns a whole run's budget discovering it is blank, then
    // reports noise the parent has to interpret.
    expect(validateDelegation(['real work', '', '   '])).toEqual({ tasks: ['real work'] })
  })

  it('refuses when every entry was blank', () => {
    const result = validateDelegation(['', '  '])
    expect(result).toHaveProperty('error')
    expect('error' in result && result.error).toMatch(/every entry was empty/i)
  })

  it('refuses more than the machine can actually run at once', () => {
    const result = validateDelegation(['a', 'b', 'c', 'd'])
    expect('error' in result && result.error).toMatch(/4 requested, 3 is the most/)
  })

  it('allows exactly the ceiling', () => {
    expect(validateDelegation(['a', 'b', 'c'])).toEqual({ tasks: ['a', 'b', 'c'] })
    expect(MAX_SUB_AGENTS).toBe(3)
  })

  it('truncates a task rather than refusing the whole delegation over one', () => {
    const long = 'x'.repeat(MAX_TASK_LENGTH + 500)
    const result = validateDelegation([long])
    expect('tasks' in result && result.tasks[0].length).toBe(MAX_TASK_LENGTH)
  })
})

describe('subAgentTools', () => {
  it('never grants a sub-agent something its parent lacked', () => {
    // The safety model here is structural: what a run can do is what was
    // wired up for it, so an escalation has to be impossible rather than
    // discouraged.
    const tools = subAgentTools(['read_file', 'find_skill'])
    expect(tools).not.toContain('write_file')
    expect(tools).not.toContain('run_command')
  })

  it('always includes finish_goal, which is how a run ends', () => {
    expect(subAgentTools([])).toContain('finish_goal')
  })

  it('strips delegate, so one level of fan-out cannot become a fork bomb', () => {
    expect(subAgentTools(['read_file', 'delegate'])).not.toContain('delegate')
  })

  it('passes the parent’s real tools through', () => {
    const tools = subAgentTools(['read_file', 'grep_files'])
    expect(tools).toContain('read_file')
    expect(tools).toContain('grep_files')
  })
})

describe('subAgentName', () => {
  it('names the three positions a delegation can fill', () => {
    expect([0, 1, 2].map(subAgentName)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('falls back rather than returning undefined past the ceiling', () => {
    // `MAX_SUB_AGENTS` keeps this unreachable today, but a name that came back
    // undefined would render as the word "undefined" in a report heading.
    expect(subAgentName(9)).toBe('Agent 10')
  })
})

describe('renderReports', () => {
  const report = (overrides: Partial<SubAgentReport> = {}): SubAgentReport => ({
    task: 'check the auth module',
    runId: 'run-1',
    status: 'done',
    report: 'Found an unchecked null on line 40.',
    ...overrides
  })

  it('labels each report with the task it answers', () => {
    // The parent asked several at once and they do not finish in order.
    const text = renderReports([
      report({ task: 'auth' }),
      report({ task: 'parsing', report: 'Nothing obvious.' })
    ])
    expect(text).toContain('Task: auth')
    expect(text).toContain('Task: parsing')
    // Named, and named in order — the same names the pips beside the run's
    // title carry, so "Bravo found the null" points at something.
    expect(text).toContain('### Alpha')
    expect(text.indexOf('Alpha')).toBeLessThan(text.indexOf('Bravo'))
  })

  it('says a sub-agent produced nothing rather than leaving a gap', () => {
    // An empty section reads as "nothing found", which is a different claim
    // from "it never reported".
    const text = renderReports([report({ report: '   ', status: 'stopped' })])
    expect(text).toMatch(/reported nothing/i)
    expect(text).toContain('stopped')
  })

  it('carries the status, so a failed sub-agent is not read as a clean result', () => {
    expect(renderReports([report({ status: 'error' })])).toContain('error')
  })

  it('handles nothing having run', () => {
    expect(renderReports([])).toBe('No sub-agents ran.')
  })
})

describe('splitRunBudget', () => {
  const parent = {
    limitsEnabled: true,
    maxTurns: 30,
    maxTokens: 300_000,
    maxDurationMinutes: 60
  }
  const fresh = { turns: 0, tokens: 0, minutes: 0 }

  it('divides what is left, so a delegation cannot exceed the run’s own limit', () => {
    // The property the whole function exists for: turning sub-agents on must
    // not quietly multiply every configured limit by four.
    const result = splitRunBudget(parent, { turns: 6, tokens: 60_000, minutes: 10 }, 3)
    expect('budget' in result && result.budget.maxTurns).toBe(8) // (30-6)/3
    expect('budget' in result && result.budget.maxTokens).toBe(80_000) // (300k-60k)/3
  })

  it('does not divide duration, because sub-agents run at the same time', () => {
    // Dividing wall-clock time between concurrent runs would charge each of
    // them for the others' waiting.
    const result = splitRunBudget(parent, { turns: 0, tokens: 0, minutes: 15 }, 3)
    expect('budget' in result && result.budget.maxDurationMinutes).toBe(45)
  })

  it('leaves an unlimited run’s children unlimited', () => {
    const result = splitRunBudget({ ...parent, limitsEnabled: false }, fresh, 3)
    expect('budget' in result && result.budget.limitsEnabled).toBe(false)
  })

  it('refuses when there are not enough turns to go round', () => {
    const result = splitRunBudget(parent, { turns: 28, tokens: 0, minutes: 0 }, 3)
    expect('error' in result && result.error).toMatch(/not enough turns/i)
    // The model's only lever is asking for fewer, so the message has to say so.
    expect('error' in result && result.error).toMatch(/fewer tasks/i)
  })

  it('allows the same remainder when fewer sub-agents are asked for', () => {
    // Same budget, two agents instead of three: (30-28)/2 = 1 turn each.
    const result = splitRunBudget(parent, { turns: 28, tokens: 0, minutes: 0 }, 2)
    expect('budget' in result && result.budget.maxTurns).toBe(1)
  })

  it('refuses a token slice too small to report anything', () => {
    const result = splitRunBudget(
      { ...parent, maxTokens: 2_000 },
      { turns: 0, tokens: 0, minutes: 0 },
      3
    )
    expect('error' in result && result.error).toMatch(/not enough tokens/i)
  })

  it('refuses when the run is nearly out of time', () => {
    const result = splitRunBudget(parent, { turns: 0, tokens: 0, minutes: 60 }, 2)
    expect('error' in result && result.error).toMatch(/not enough time/i)
  })

  it('never returns a negative allowance for an overspent run', () => {
    // Budgets are checked after a turn, so a run can end up past its limit.
    const result = splitRunBudget(parent, { turns: 99, tokens: 999_999, minutes: 999 }, 1)
    expect(result).toHaveProperty('error')
  })
})
