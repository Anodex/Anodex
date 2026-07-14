import { describe, expect, it } from 'vitest'
import { buildRunEnabledTools } from '../AgentRunService'

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
