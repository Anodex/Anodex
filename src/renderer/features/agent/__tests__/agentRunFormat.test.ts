import { describe, expect, it } from 'vitest'
import type { AgentRun } from '@shared/agentRun.types'
import { providerLabel } from '../agentRunFormat'

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
