import { describe, expect, it } from 'vitest'
import type { Skill } from '@shared/skill.types'
import { buildActiveSkillContext } from '../activeSkillContext'

function skill(name: string, body: string): Skill {
  return {
    name,
    description: `${name} workflow`,
    scope: 'project',
    keywords: [name],
    tools: [],
    body,
    filePath: `/skills/${name}.md`
  }
}

describe('buildActiveSkillContext', () => {
  it('loads pinned skills in project order and skips missing names', () => {
    const context = buildActiveSkillContext(
      [skill('feature-tdd', 'Write the test first.'), skill('code-review', 'Review the diff.')],
      ['code-review', 'missing', 'feature-tdd']
    )

    expect(context).toContain('## code-review')
    expect(context).toContain('Review the diff.')
    expect(context).toContain('## feature-tdd')
    expect(context).toContain('Write the test first.')
    expect(context).not.toContain('missing')
    expect(context!.indexOf('## code-review')).toBeLessThan(context!.indexOf('## feature-tdd'))
  })

  it('returns null when no pinned skill exists in the catalog', () => {
    expect(buildActiveSkillContext([skill('code-review', 'Review.')], ['missing'])).toBeNull()
  })
})
