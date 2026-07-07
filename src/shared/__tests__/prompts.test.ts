import { describe, expect, it } from 'vitest'
import { composeSystemPrompt, NO_WORKSPACE_NOTE, READ_ONLY_WORKSPACE_NOTE } from '../prompts'

describe('composeSystemPrompt', () => {
  it('includes the no-workspace note when no workspace is selected', () => {
    const prompt = composeSystemPrompt({ hasWorkspaceTools: false, hasProject: false })
    expect(prompt).toContain(NO_WORKSPACE_NOTE)
    expect(prompt).not.toContain(READ_ONLY_WORKSPACE_NOTE)
  })

  it('includes the read-only note when a workspace is selected but no project is open', () => {
    const prompt = composeSystemPrompt({ hasWorkspaceTools: true, hasProject: false })
    expect(prompt).toContain(READ_ONLY_WORKSPACE_NOTE)
    expect(prompt).not.toContain(NO_WORKSPACE_NOTE)
  })

  it('includes neither note once a project is open', () => {
    const prompt = composeSystemPrompt({ hasWorkspaceTools: true, hasProject: true })
    expect(prompt).not.toContain(READ_ONLY_WORKSPACE_NOTE)
    expect(prompt).not.toContain(NO_WORKSPACE_NOTE)
  })

  it('omits the Memory section when there is no retrieved memory context', () => {
    const prompt = composeSystemPrompt({ hasWorkspaceTools: true, hasProject: true })
    expect(prompt).not.toContain('# Memory')
  })

  it('includes retrieved memory context under its own section, between Workspace and Project instructions', () => {
    const prompt = composeSystemPrompt({
      hasWorkspaceTools: true,
      hasProject: true,
      workspaceContext: 'Name: anodex',
      memoryContext: '- [convention] Uses pnpm, not npm. (project)',
      projectRules: 'Run pnpm test after changes.'
    })
    expect(prompt).toContain('# Memory')
    expect(prompt).toContain('Uses pnpm, not npm.')
    expect(prompt.indexOf('# Workspace')).toBeLessThan(prompt.indexOf('# Memory'))
    expect(prompt.indexOf('# Memory')).toBeLessThan(prompt.indexOf('# Project instructions'))
  })
})
