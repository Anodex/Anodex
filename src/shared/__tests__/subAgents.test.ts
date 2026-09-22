import { describe, expect, it } from 'vitest'
import {
  MAX_SUB_AGENTS,
  MAX_TASK_LENGTH,
  maxSubAgentsFor,
  subAgentProviderFor,
  renderReports,
  splitRunBudget,
  subAgentName,
  subAgentNames,
  subAgentTools,
  taskLabel,
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

describe('maxSubAgentsFor', () => {
  it('leaves no room on a single-slot local engine', () => {
    // The parent holds the only slot for the whole of its turn, so a child
    // would wait for a slot the parent cannot release until the child is
    // done. Measured: 33 minutes at turn zero, both sides silent.
    expect(maxSubAgentsFor('local', 1)).toBe(0)
  })

  it('allows one fewer than the slots, because the parent is one of them', () => {
    expect(maxSubAgentsFor('local', 2)).toBe(1)
    expect(maxSubAgentsFor('local', 3)).toBe(2)
  })

  it('never exceeds the product ceiling however many slots there are', () => {
    expect(maxSubAgentsFor('local', 99)).toBe(MAX_SUB_AGENTS)
  })

  it('ignores slots entirely for a cloud provider', () => {
    // No gate there: the calls are HTTP and genuinely concurrent.
    expect(maxSubAgentsFor('anthropic', 1)).toBe(MAX_SUB_AGENTS)
    expect(maxSubAgentsFor('openai', 1)).toBe(MAX_SUB_AGENTS)
  })

  it('is not fooled by a nonsense slot count', () => {
    expect(maxSubAgentsFor('local', 0)).toBe(0)
    expect(maxSubAgentsFor('local', -3)).toBe(0)
    expect(maxSubAgentsFor('local', 2.9)).toBe(1)
  })
})

describe('sub-agents on other providers', () => {
  it('lifts the local ceiling when the children run elsewhere', () => {
    // The gate only serialises local generation. A local parent holding the
    // one slot while its sub-agents talk to a cloud provider over HTTP has
    // nothing to contend with — which is the configuration that makes this
    // usable on a single-GPU machine at all.
    expect(maxSubAgentsFor('local', 1, ['deepseek'])).toBe(MAX_SUB_AGENTS)
    expect(maxSubAgentsFor('local', 1, ['deepseek', 'anthropic', 'openai'])).toBe(MAX_SUB_AGENTS)
  })

  it('still applies the gate when any child is local', () => {
    // One local child is enough to need a slot the parent is holding.
    expect(maxSubAgentsFor('local', 1, ['deepseek', 'local'])).toBe(0)
    expect(maxSubAgentsFor('local', 3, ['local', 'deepseek'])).toBe(2)
  })

  it('falls back to the parent when no providers are configured', () => {
    expect(maxSubAgentsFor('local', 1, [])).toBe(0)
    expect(maxSubAgentsFor('deepseek', 1, [])).toBe(MAX_SUB_AGENTS)
  })
})

describe('subAgentProviderFor', () => {
  it('inherits the parent when nothing is configured', () => {
    expect(subAgentProviderFor(0, [], 'local')).toBe('local')
    expect(subAgentProviderFor(2, [], 'deepseek')).toBe('deepseek')
  })

  it('gives each sub-agent its own provider, in order', () => {
    const providers = ['deepseek', 'anthropic', 'openai']
    expect([0, 1, 2].map((i) => subAgentProviderFor(i, providers, 'local'))).toEqual(providers)
  })

  it('wraps rather than running out', () => {
    // A two-entry list and a three-way fan-out is a better answer than
    // refusing the delegation or silently dropping a task.
    expect(subAgentProviderFor(2, ['deepseek', 'anthropic'], 'local')).toBe('deepseek')
  })
})

describe('validateDelegation against a real ceiling', () => {
  it('refuses outright when the engine has no spare slot', () => {
    const result = validateDelegation(['a'], 0)
    expect('error' in result && result.error).toMatch(/no spare generation slot/i)
  })

  it('names the real ceiling rather than the product maximum', () => {
    // Telling a model "3 is the most" when 2 is the most invites it to retry
    // with 3 and deadlock.
    const result = validateDelegation(['a', 'b', 'c'], 2)
    expect('error' in result && result.error).toMatch(/3 requested, 2 is the most/)
  })

  it('accepts a fan-out that fits the spare slots', () => {
    expect(validateDelegation(['a', 'b'], 2)).toEqual({ tasks: ['a', 'b'] })
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

describe('taskLabel', () => {
  it('drops the instruction and keeps the subject', () => {
    // Every delegated task opens the same way, because that is how a parent
    // phrases an instruction — three agents all labelled "Check the" would
    // be worse than no labels.
    expect(taskLabel('check the tokenizer for off-by-one errors')).toBe('Tokenizer off-by-one')
    expect(taskLabel('Look through the error recovery paths')).toBe('Error recovery paths')
  })

  it('reduces a path to the part that identifies it', () => {
    // Truncated to fit a chip, which is why it is the file and not the path.
    expect(taskLabel('search src/main/tools/registry.ts for unchecked nulls')).toBe('registry.ts')
  })

  it('leaves an identifier’s own casing alone', () => {
    // Title-casing `readFile` makes it a different name.
    expect(taskLabel('review readFile error handling')).toBe('readFile error')
  })

  it('stays inside the width a chip can show', () => {
    const label = taskLabel(
      'investigate the extraordinarily convoluted authentication middleware layer'
    )
    expect(label && label.length).toBeLessThanOrEqual(20)
  })

  it('gives up rather than returning noise', () => {
    // A label that is a garbled fragment looks like information while being
    // none, which is worse than falling back to a call-sign.
    expect(taskLabel('check the')).toBeNull()
    expect(taskLabel('   ')).toBeNull()
    expect(taskLabel('...')).toBeNull()
  })
})

describe('subAgentNames', () => {
  it('names each sub-agent after what it was sent to do', () => {
    expect(
      subAgentNames(['check the tokenizer', 'check error recovery paths', 'check unicode handling'])
    ).toEqual(['Tokenizer', 'Error recovery paths', 'Unicode handling'])
  })

  it('falls back for the whole set when two labels collide', () => {
    // Two sub-agents both called "Parser" stop doing the one job a name has.
    expect(subAgentNames(['check the parser', 'review the parser'])).toEqual(['Alpha', 'Bravo'])
  })

  it('falls back for the whole set when one task yields nothing', () => {
    // A mixed set is no better: the reader cannot tell whether "Bravo" is a
    // label or a fallback.
    expect(subAgentNames(['check the tokenizer', 'check the'])).toEqual(['Alpha', 'Bravo'])
  })

  it('ignores case when deciding two labels are the same', () => {
    expect(subAgentNames(['check Parser rules', 'review parser rules'])).toEqual(['Alpha', 'Bravo'])
  })

  it('handles a delegation of one', () => {
    expect(subAgentNames(['check the tokenizer'])).toEqual(['Tokenizer'])
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
    // Named after the work rather than by position, and named in order — the
    // same names the chips beside the run's title carry, so a reader can go
    // from "Auth found the null" to that sub-agent's transcript.
    expect(text).toContain('### Auth')
    expect(text.indexOf('Auth')).toBeLessThan(text.indexOf('Parsing'))
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
