import { describe, expect, it } from 'vitest'
import { parseSkillFile } from '../skillFile'

const VALID = `---
name: stock-research
description: Research public stock/ETF data for a simulated portfolio.
keywords: [stocks, investing, finance]
tools: [web_search, fetch_url]
---

# Stock research

Look up recent price and news for the given ticker.
`

describe('parseSkillFile', () => {
  it('parses a well-formed skill file', () => {
    const skill = parseSkillFile(VALID, '/skills/stock-research.md')

    expect(skill.name).toBe('stock-research')
    expect(skill.description).toBe('Research public stock/ETF data for a simulated portfolio.')
    expect(skill.keywords).toEqual(['stocks', 'investing', 'finance'])
    expect(skill.tools).toEqual(['web_search', 'fetch_url'])
    expect(skill.body).toContain('Look up recent price and news')
    expect(skill.filePath).toBe('/skills/stock-research.md')
  })

  it('defaults keywords/tools to an empty array when omitted', () => {
    const raw = `---\nname: minimal\ndescription: A minimal skill.\n---\nBody text.\n`
    const skill = parseSkillFile(raw, '/skills/minimal.md')

    expect(skill.keywords).toEqual([])
    expect(skill.tools).toEqual([])
    expect(skill.body).toBe('Body text.')
  })

  it('throws when the file does not start with a frontmatter block', () => {
    expect(() => parseSkillFile('name: x\ndescription: y\n', '/skills/bad.md')).toThrow(
      /must start with a "---" frontmatter block/
    )
  })

  it('throws when the frontmatter block is unterminated', () => {
    const raw = `---\nname: x\ndescription: y\n`
    expect(() => parseSkillFile(raw, '/skills/bad.md')).toThrow(/unterminated frontmatter/)
  })

  it('throws when a required field is missing', () => {
    const raw = `---\nname: no-description\n---\nBody.\n`
    expect(() => parseSkillFile(raw, '/skills/bad.md')).toThrow(
      /missing required field "description"/
    )
  })

  it('throws on an invalid frontmatter line', () => {
    const raw = `---\nname: x\ndescription y\n---\nBody.\n`
    expect(() => parseSkillFile(raw, '/skills/bad.md')).toThrow(/invalid frontmatter line/)
  })
})
