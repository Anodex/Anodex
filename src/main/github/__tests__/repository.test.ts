import { describe, expect, it } from 'vitest'
import { normalizeGithubRepository } from '../repository'

describe('normalizeGithubRepository', () => {
  it.each([
    ['owner/repo', 'owner/repo'],
    ['https://github.com/owner/repo.git', 'owner/repo'],
    ['git@github.com:owner/repo.git', 'owner/repo'],
    ['ssh://git@github.com/owner/repo.git', 'owner/repo']
  ])('normalizes %s', (input, expected) => {
    expect(normalizeGithubRepository(input)).toBe(expected)
  })

  it('rejects non-GitHub and malformed repository values', () => {
    expect(normalizeGithubRepository('https://gitlab.com/owner/repo')).toBeNull()
    expect(normalizeGithubRepository('owner/repo/extra')).toBeNull()
  })
})
