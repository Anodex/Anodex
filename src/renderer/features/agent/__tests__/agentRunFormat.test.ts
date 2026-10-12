import { describe, expect, it } from 'vitest'
import type { AgentRun } from '@shared/agentRun.types'
import type { Plan } from '@shared/plan.types'
import {
  continueLabel,
  goalHeadline,
  isLongGoal,
  plainStopReason,
  planOutranResult,
  planTally,
  providerLabel,
  ranOut,
  ranOutBrief,
  ranOutDetail,
  runOutcomeText,
  runStatusLabel,
  spentLine,
  whatChanged
} from '../agentRunFormat'

/**
 * `providerLabel` used to test for `local`, then `anthropic`, then fall through
 * to OpenAI for everything else. That was correct while agent runs accepted
 * only three providers; once they accepted all twelve, a DeepSeek run rendered
 * in the run list as "OpenAI · deepseek-v4-flash" — the wrong vendor, stated
 * confidently, on a row whose whole job is to say what produced the work.
 */
function run(overrides: Partial<AgentRun>): AgentRun {
  return { provider: 'local', model: null, ...overrides } as AgentRun
}

describe('providerLabel', () => {
  it('names the local engine', () => {
    expect(providerLabel(run({ provider: 'local' }))).toBe('Local')
  })

  it('names Claude with its model', () => {
    expect(providerLabel(run({ provider: 'anthropic', model: 'claude-sonnet-5' }))).toContain(
      'Claude'
    )
  })

  it('names OpenAI with its model', () => {
    expect(providerLabel(run({ provider: 'openai', model: 'gpt-5.6' }))).toContain('OpenAI')
  })

  it('does not attribute another vendor to OpenAI', () => {
    const label = providerLabel(run({ provider: 'deepseek', model: 'deepseek-v4-flash' }))
    expect(label).not.toContain('OpenAI')
    expect(label).toContain('DeepSeek')
  })

  it('names every other provider by its own vendor', () => {
    expect(providerLabel(run({ provider: 'groq', model: 'llama-3.3-70b-versatile' }))).toContain(
      'Groq'
    )
    expect(providerLabel(run({ provider: 'qwen', model: 'qwen-max' }))).toContain('Qwen')
    expect(providerLabel(run({ provider: 'kimi', model: 'kimi-k3' }))).toContain('Kimi')
  })

  it('shows a friendly model name when the catalog knows it', () => {
    expect(providerLabel(run({ provider: 'deepseek', model: 'deepseek-v4-flash' }))).toBe(
      'DeepSeek · DeepSeek V4 Flash'
    )
  })

  it('falls back to the raw model id for a model not in the catalog', () => {
    // Azure deployments are user-named, and a live-fetched OpenAI id may be
    // newer than the bundled catalog; showing the raw id beats showing nothing.
    expect(providerLabel(run({ provider: 'azure', model: 'my-deployment' }))).toBe(
      'Azure OpenAI · my-deployment'
    )
  })
})

/**
 * Goals are written, not typed into a one-line field. A long one squashed into
 * a header put a thousand lines of specification in the page title, with its
 * `**` markers showing.
 */
describe('goalHeadline', () => {
  it('names a goal by its first line, without markdown markers', () => {
    const goal = [
      'Yes. Here is the **single combined master prompt**, with images.',
      '',
      '```text',
      'PROJECT: NEBULA',
      '```'
    ].join('\n')
    expect(goalHeadline(goal)).toBe('Yes. Here is the single combined master prompt, with images.')
  })

  it('skips fences, rules and blank lines to find the first words', () => {
    const goal = ['', '```text', '=====', '## Build the engine', 'more'].join('\n')
    expect(goalHeadline(goal)).toBe('Build the engine')
  })

  it('keeps a one-line goal as it is', () => {
    expect(goalHeadline('Summarize the changelog')).toBe('Summarize the changelog')
  })
})

describe('isLongGoal', () => {
  it('folds a goal that is long in characters or in lines', () => {
    expect(isLongGoal('Summarize the changelog')).toBe(false)
    expect(isLongGoal('x'.repeat(2000))).toBe(true)
    expect(isLongGoal(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'))).toBe(true)
  })
})

describe('runOutcomeText', () => {
  it('says why a run stopped rather than what its last reply said', () => {
    // Seen on this machine: a run stopped at its turn limit showed "all 2 steps
    // complete" in the warning colour, hiding the reason.
    expect(
      runOutcomeText({
        status: 'stopped',
        summary: 'all 2 steps complete',
        lastError: 'Stopped after 8 turns without finishing.'
      })
    ).toBe('Stopped after 8 turns without finishing.')
  })

  it('shows the summary for a run that finished', () => {
    expect(
      runOutcomeText({ status: 'done', summary: 'Listed the folders.', lastError: null })
    ).toBe('Listed the folders.')
  })

  it('falls back to whichever exists', () => {
    expect(runOutcomeText({ status: 'stopped', summary: 'Partial.', lastError: null })).toBe(
      'Partial.'
    )
    expect(runOutcomeText({ status: 'done', summary: null, lastError: null })).toBe('')
  })
})

describe('runs that ran out', () => {
  const stopped = {
    status: 'stopped',
    limitsEnabled: true,
    maxTurns: 3,
    turnsUsed: 3,
    maxTokens: 50_000,
    tokensUsed: 433,
    maxDurationMinutes: 30,
    activeMs: 11_000,
    activeSinceAt: null
  } as const

  it('names which limit, and says what to do, in the phone’s words', () => {
    expect(ranOut(stopped)).toBe('turns')
    expect(runStatusLabel(stopped)).toBe('Ran out of turns')
    expect(plainStopReason(stopped)).toBe(
      'It used all 3 of its turns before finishing. Continue it to carry on.'
    )
    expect(continueLabel(stopped)).toBe('Continue for 3 more turns')
    expect(spentLine(stopped)).toBe('433 tokens · under a minute')
  })

  it('gives the run list a short line, since its Continue button says what to do', () => {
    expect(ranOutBrief(stopped)).toBe('Used all 3 turns before finishing')
    expect(ranOutBrief({ ...stopped, tokensUsed: 50_000 })).toBe(
      'Used its 50.0k tokens before finishing'
    )
    expect(ranOutBrief({ ...stopped, turnsUsed: 1 })).toBeNull()
  })

  it('reads the reason from the numbers, so older wording does not matter', () => {
    expect(ranOut({ ...stopped, tokensUsed: 50_000 })).toBe('tokens')
    expect(ranOut({ ...stopped, turnsUsed: 1, activeMs: 30 * 60_000 })).toBe('time')
  })

  it('leaves every other stop alone', () => {
    expect(ranOut({ ...stopped, turnsUsed: 1 })).toBeNull()
    expect(ranOut({ ...stopped, status: 'done' })).toBeNull()
    expect(ranOut({ ...stopped, limitsEnabled: false })).toBeNull()
    expect(runStatusLabel({ ...stopped, turnsUsed: 1 })).toBe('Stopped')
    expect(plainStopReason({ ...stopped, turnsUsed: 1 })).toBeNull()
  })

  it('gives the run page the figures with the sentence', () => {
    expect(ranOutDetail(stopped)).toBe(
      'It used all 3 of its turns before finishing. It used 433 of 50,000 tokens and under a ' +
        'minute, so the turn limit is what stopped it. Continue it if it was making progress.'
    )
  })
})

describe('whatChanged', () => {
  it("reads the turn report's What changed line", () => {
    const reply =
      'I found the plan for saying hello in three languages.\n\n' +
      'What changed: Created a plan with 3 steps to say hello in three languages.\n' +
      'Is it done: No\nWhat would I do next: Start the first step.'
    expect(whatChanged(reply)).toBe('Created a plan with 3 steps to say hello in three languages.')
  })

  it('tolerates bold labels, and gives nothing when there is no report', () => {
    expect(whatChanged('**What changed:** Fixed the build.')).toBe('Fixed the build.')
    expect(whatChanged('Just a reply.')).toBeNull()
  })
})

describe('planOutranResult', () => {
  const plan = (statuses: Array<'pending' | 'in_progress' | 'completed'>): Plan => ({
    title: 'Plan',
    updatedAt: 0,
    steps: statuses.map((status, i) => ({ id: String(i), title: `Step ${i}`, status }))
  })

  it('flags a stopped run whose every step is ticked off', () => {
    expect(planOutranResult({ status: 'stopped', plan: plan(['completed', 'completed']) })).toBe(
      true
    )
    expect(planTally(plan(['completed', 'completed', 'pending']))).toBe('2 of 3 ticked off')
  })

  it('leaves finished runs and unfinished plans alone', () => {
    expect(planOutranResult({ status: 'done', plan: plan(['completed']) })).toBe(false)
    expect(planOutranResult({ status: 'stopped', plan: plan(['completed', 'pending']) })).toBe(
      false
    )
    expect(planOutranResult({ status: 'stopped', plan: null })).toBe(false)
  })
})
