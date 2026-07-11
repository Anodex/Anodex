import { describe, expect, it } from 'vitest'
import type { Skill } from '@shared/skill.types'
import { buildIndex, search } from '../skillSearch'

function makeSkill(overrides: Partial<Skill>): Skill {
  return {
    name: 'skill',
    description: 'A skill.',
    keywords: [],
    tools: [],
    body: '',
    filePath: '/skills/skill.md',
    ...overrides
  }
}

const STOCKS = makeSkill({
  name: 'stock-research',
  description: 'Research public stock and ETF market data.',
  keywords: ['stocks', 'investing', 'finance']
})
const COMMIT = makeSkill({
  name: 'commit-message',
  description: 'Draft a concise git commit message from staged changes.',
  keywords: ['git', 'commit']
})
const SUMMARY = makeSkill({
  name: 'web-summary',
  description: 'Summarize a web page into a few bullet points.',
  keywords: ['web', 'summary']
})

describe('search', () => {
  it('ranks the most relevant skill first', () => {
    const index = buildIndex([STOCKS, COMMIT, SUMMARY])
    const results = search(index, 'stock market investing', 5)

    expect(results[0].name).toBe('stock-research')
  })

  it('returns an empty array for an empty catalog', () => {
    const index = buildIndex([])
    expect(search(index, 'anything')).toEqual([])
  })

  it('returns an empty array for a blank query', () => {
    const index = buildIndex([STOCKS, COMMIT])
    expect(search(index, '   ')).toEqual([])
  })

  it('respects the limit', () => {
    const index = buildIndex([STOCKS, COMMIT, SUMMARY])
    const results = search(index, 'skill', 1)
    expect(results.length).toBeLessThanOrEqual(1)
  })

  it('falls back to substring matching when BM25 finds no term overlap', () => {
    // "plugh" only ever appears embedded inside a longer token
    // ("xyzzyplughthing"), so the tokenizer never produces a "plugh" term on
    // its own — BM25 legitimately scores zero, which is what should trigger
    // the substring fallback (raw, untokenized text still contains "plugh").
    const oddball = makeSkill({
      name: 'xyzzyplughthing',
      description: 'A skill about xyzzyplughthing.'
    })
    const index = buildIndex([STOCKS, oddball])

    const results = search(index, 'plugh')

    expect(results.map((r) => r.name)).toEqual(['xyzzyplughthing'])
  })
})
