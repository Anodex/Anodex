import { describe, expect, it } from 'vitest'
import type { SkillSummary } from '@shared/skill.types'
import { applySkillSuggestion, getAppliedSkillName, getSkillSuggestions } from '../skillSuggestions'

const SKILLS: SkillSummary[] = [
  {
    name: 'code-review',
    description: 'Review Anodex code for bugs, regressions, and maintainability.',
    scope: 'project',
    keywords: ['review', 'diff', 'bugs']
  },
  {
    name: 'release-checklist',
    description: 'Prepare a release with checks, notes, and packaging steps.',
    scope: 'project',
    keywords: ['release', 'build']
  },
  {
    name: 'songwriting',
    description: 'Draft lyrics and music prompts.',
    scope: 'personal',
    keywords: ['music']
  }
]

describe('getSkillSuggestions', () => {
  it('returns the highest scoring skills for the current request text', () => {
    const results = getSkillSuggestions(SKILLS, 'please review this diff for bugs')

    expect(results.map((skill) => skill.name)).toEqual(['code-review'])
  })

  it('does not suggest skills for very short or blank text', () => {
    expect(getSkillSuggestions(SKILLS, 're')).toEqual([])
    expect(getSkillSuggestions(SKILLS, '   ')).toEqual([])
  })

  it('prefers project skills over personal skills when scores tie', () => {
    const results = getSkillSuggestions(
      [
        { name: 'personal-review', description: 'Review code.', scope: 'personal', keywords: [] },
        { name: 'project-review', description: 'Review code.', scope: 'project', keywords: [] }
      ],
      'review code'
    )

    expect(results.map((skill) => skill.name)).toEqual(['project-review', 'personal-review'])
  })

  it('orders pinned skills before unpinned matches', () => {
    const results = getSkillSuggestions(
      [
        { name: 'release-checklist', description: 'Release code.', scope: 'project', keywords: [] },
        { name: 'code-review', description: 'Review code.', scope: 'project', keywords: [] }
      ],
      'review release code',
      { pinnedSkillNames: ['code-review'] }
    )

    expect(results.map((skill) => skill.name)).toEqual(['code-review', 'release-checklist'])
  })
})

describe('applySkillSuggestion', () => {
  it('prepends a concise skill-use instruction without dropping the user text', () => {
    expect(applySkillSuggestion('code-review', 'look at the sidebar')).toBe(
      'Use the `code-review` skill for this request.\n\nlook at the sidebar'
    )
  })

  it('does not duplicate an already-applied skill instruction', () => {
    const text = 'Use the `code-review` skill for this request.\n\nlook at the sidebar'

    expect(applySkillSuggestion('code-review', text)).toBe(text)
  })
})

describe('getAppliedSkillName', () => {
  it('reads the explicit skill-use instruction from composer text', () => {
    expect(getAppliedSkillName('Use the `code-review` skill for this request.\n\nlook')).toBe(
      'code-review'
    )
  })

  it('returns null when no skill instruction is present', () => {
    expect(getAppliedSkillName('please review this')).toBeNull()
  })
})
