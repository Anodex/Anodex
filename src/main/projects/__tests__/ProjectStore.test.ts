import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/project.types'
import { normalizePinnedSkillNames, normalizeProject } from '../ProjectStore'

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Anodex',
    folderPath: '/workspace/anodex',
    instructions: undefined,
    pinnedSkillNames: [],
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    ...overrides
  }
}

describe('normalizePinnedSkillNames', () => {
  it('trims, deduplicates, and drops blank skill names', () => {
    expect(normalizePinnedSkillNames([' code-review ', '', 'code-review', 'feature-tdd'])).toEqual([
      'code-review',
      'feature-tdd'
    ])
  })
})

describe('normalizeProject', () => {
  it('defaults legacy projects to no pinned skills', () => {
    const legacy = makeProject() as Omit<Project, 'pinnedSkillNames'> & {
      pinnedSkillNames?: string[]
    }
    delete legacy.pinnedSkillNames

    expect(normalizeProject(legacy).pinnedSkillNames).toEqual([])
  })

  it('normalizes pinned skill names on load', () => {
    expect(
      normalizeProject(makeProject({ pinnedSkillNames: [' code-review ', 'code-review'] }))
        .pinnedSkillNames
    ).toEqual(['code-review'])
  })
})
