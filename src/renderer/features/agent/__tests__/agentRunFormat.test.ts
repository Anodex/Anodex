import { describe, expect, it } from 'vitest'
import type { AgentRun } from '@shared/agentRun.types'
import { goalHeadline, isLongGoal, providerLabel } from '../agentRunFormat'

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
