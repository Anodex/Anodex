import { describe, expect, it } from 'vitest'
import { toolActionLabel, toolActionTarget } from '../toolActionLabel'

describe('toolActionLabel', () => {
  it('says a known tool in words, past tense once it has finished', () => {
    expect(toolActionLabel({ name: 'run_command', title: 'Run: echo hi', status: 'success' })).toBe(
      'Ran a command'
    )
    expect(toolActionLabel({ name: 'finish_goal', title: 'Finish goal', status: 'success' })).toBe(
      'Finished the goal'
    )
  })

  it('never says a failed or declined call happened', () => {
    expect(toolActionLabel({ name: 'finish_goal', title: 'Finish goal', status: 'error' })).toBe(
      'Finishing the goal failed'
    )
    expect(toolActionLabel({ name: 'run_command', title: 'Run: rm x', status: 'denied' })).toBe(
      'Running a command was declined'
    )
  })

  it('and in the present while it is still going', () => {
    expect(toolActionLabel({ name: 'web_search', title: 'Search: x', status: 'running' })).toBe(
      'Searching the web'
    )
  })

  it("falls back to the title's own action word for a tool it does not know", () => {
    const call = { name: 'summon_kraken', title: 'Summon: the kraken', status: 'success' } as const
    expect(toolActionLabel(call)).toBe('Summon')
    expect(toolActionTarget(call)).toBe('the kraken')
  })

  it('names what the call acted on, without its action word', () => {
    expect(toolActionTarget({ name: 'run_command', title: 'Run: echo hi' })).toBe('echo hi')
    expect(toolActionTarget({ name: 'read_file', title: 'Read src/App.tsx' })).toBe('src/App.tsx')
  })

  it('drops a target the words already say', () => {
    expect(toolActionTarget({ name: 'finish_goal', title: 'Finish goal' })).toBe('')
  })

  it('says a one-word title once, not twice', () => {
    expect(toolActionTarget({ name: 'mystery', title: 'Thinking' })).toBe('')
    expect(toolActionTarget({ name: 'finish_goal', title: 'Finish' })).toBe('Finish')
  })
})
