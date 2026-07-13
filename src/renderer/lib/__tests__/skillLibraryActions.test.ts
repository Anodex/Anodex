import { describe, expect, it } from 'vitest'
import { duplicateSkillMarkdown, nextSkillCopyName } from '../skillLibraryActions'

describe('nextSkillCopyName', () => {
  it('chooses a stable copy name that avoids existing skills', () => {
    expect(nextSkillCopyName(['code-review'], 'code-review')).toBe('code-review-copy')
    expect(nextSkillCopyName(['code-review', 'code-review-copy'], 'code-review')).toBe(
      'code-review-copy-2'
    )
  })

  it('truncates long names to keep the generated skill name valid', () => {
    const name = nextSkillCopyName([], 'a'.repeat(64))

    expect(name.length).toBeLessThanOrEqual(64)
    expect(name.endsWith('-copy')).toBe(true)
  })
})

describe('duplicateSkillMarkdown', () => {
  it('replaces the frontmatter name and leaves the rest of the skill intact', () => {
    const markdown = `---
name: code-review
description: Review changes.
keywords: [review]
---

# Code review

Use this carefully.
`

    expect(duplicateSkillMarkdown(markdown, 'code-review-copy')).toBe(`---
name: code-review-copy
description: Review changes.
keywords: [review]
---

# Code review

Use this carefully.
`)
  })

  it('throws when the markdown does not have a frontmatter name', () => {
    expect(() => duplicateSkillMarkdown('# No frontmatter', 'copy')).toThrow(/frontmatter name/)
  })
})
