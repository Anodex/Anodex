import { describe, expect, it } from 'vitest'
import { AGENT_EXAMPLES } from '../agentExamples'

describe('AGENT_EXAMPLES', () => {
  it('offers a few starting points, each with a goal the editor can open with', () => {
    expect(AGENT_EXAMPLES.length).toBeGreaterThanOrEqual(3)
    for (const example of AGENT_EXAMPLES) {
      expect(example.seed.goal?.trim().length ?? 0).toBeGreaterThan(40)
    }
    expect(new Set(AGENT_EXAMPLES.map((e) => e.title)).size).toBe(AGENT_EXAMPLES.length)
  })

  it('only fills the editor, leaving project and settings to the person', () => {
    for (const example of AGENT_EXAMPLES) {
      expect(Object.keys(example.seed)).toEqual(['goal'])
    }
  })
})
