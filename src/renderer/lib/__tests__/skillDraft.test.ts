import { describe, expect, it } from 'vitest'
import { buildSkillDraft, skillDraftNameFromPrompt } from '../skillDraft'

describe('skillDraftNameFromPrompt', () => {
  it('creates a short slug from the user request', () => {
    expect(skillDraftNameFromPrompt('Please review this React composer UI for bugs')).toBe(
      'review-react-composer-ui'
    )
  })

  it('falls back when the prompt has no usable words', () => {
    expect(skillDraftNameFromPrompt('???')).toBe('workflow-from-chat')
  })
})

describe('buildSkillDraft', () => {
  it('creates reviewable markdown without pretending it is ready to auto-save', () => {
    const draft = buildSkillDraft({
      userPrompt: 'Debug the release checklist workflow',
      assistantContent:
        'We reproduced the issue, added a failing test, fixed the parser, and ran npm test.',
      toolNames: ['read_file', 'run_project_check']
    })

    expect(draft).toContain('name: debug-release-checklist-workflow')
    expect(draft).toContain(
      'description: Draft skill captured from chat: Debug the release checklist workflow'
    )
    expect(draft).toContain('tools: [read_file, run_project_check]')
    expect(draft).toContain(
      'Review and edit this draft before saving it as a project or personal skill.'
    )
    expect(draft).toContain('We reproduced the issue')
  })
})
