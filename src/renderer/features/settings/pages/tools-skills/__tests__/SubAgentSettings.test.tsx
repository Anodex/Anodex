// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { render } from '../../../../../test-utils/dom'
import { describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/settings.types'
import { SubAgentSettings } from '../SubAgentSettings'

/**
 * The claim this section makes about how many sub-agents a run can start.
 *
 * It exists because the answer is not guessable — it depends on the engine's
 * parallel-job count and on where the children run — which also makes it the
 * one number a user cannot check for themselves. A wrong one here is worse
 * than no number at all.
 */

function settingsWith(overrides: {
  parallelJobs: number
  subAgentProviders: string[]
  deepseekKey?: string
  anthropicKey?: string
}): AppSettings {
  const provider: Record<string, unknown> = { active: 'local' }
  for (const id of [
    'anthropic',
    'openai',
    'google',
    'xai',
    'deepseek',
    'mistral',
    'groq',
    'openrouter',
    'azure',
    'kimi',
    'qwen'
  ]) {
    provider[id] = { apiKey: '', model: '' }
  }
  provider.deepseek = { apiKey: overrides.deepseekKey ?? '', model: 'deepseek-chat' }
  provider.anthropic = { apiKey: overrides.anthropicKey ?? '', model: 'claude-sonnet-5' }

  return {
    model: { parallelJobs: overrides.parallelJobs },
    provider,
    agents: { subAgentsEnabled: true, subAgentProviders: overrides.subAgentProviders }
  } as unknown as AppSettings
}

describe('what the sub-agent section says a local run can start', () => {
  const update = vi.fn().mockResolvedValue(undefined)

  it('counts a cloud child that is actually reachable', () => {
    // Nothing local but the parent, so the engine's slots do not bound it.
    render(
      <SubAgentSettings
        settings={settingsWith({
          parallelJobs: 1,
          subAgentProviders: ['deepseek'],
          deepseekKey: 'sk-test'
        })}
        update={update}
      />
    )
    expect(screen.getByText(/local run can start up to 3/i)).toBeTruthy()
  })

  it('does not count a provider whose key has since been cleared', () => {
    // This is the case worth a test. The stored choice still names a cloud
    // provider, so the old arithmetic said three — while at run time every
    // child falls back to the parent's local engine, where the parent is
    // already holding one of the two slots and only one is free.
    render(
      <SubAgentSettings
        settings={settingsWith({ parallelJobs: 2, subAgentProviders: ['anthropic'] })}
        update={update}
      />
    )
    expect(screen.getByText(/local run can start up to 1/i)).toBeTruthy()
    expect(screen.queryByText(/local run can start up to 3/i)).toBeNull()
  })

  it('says where a stale slot will really run instead of naming a dead provider', () => {
    render(
      <SubAgentSettings
        settings={settingsWith({ parallelJobs: 2, subAgentProviders: ['anthropic'] })}
        update={update}
      />
    )
    expect(screen.getByText(/anthropic has no API key any more/i)).toBeTruthy()
  })
})
