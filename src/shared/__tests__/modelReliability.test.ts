import { describe, expect, it } from 'vitest'
import {
  computeReliabilityScore,
  MIN_ATTEMPTS_FOR_RELIABILITY_SCORE,
  type ModelReliabilityRecord
} from '../modelReliability.types'

function record(overrides: Partial<ModelReliabilityRecord> = {}): ModelReliabilityRecord {
  return {
    modelId: 'm1',
    modelName: 'Test Model',
    byTool: {},
    fabrications: 0,
    lastUsedAt: Date.now(),
    ...overrides
  }
}

describe('computeReliabilityScore', () => {
  it('returns null when there is no record at all', () => {
    expect(computeReliabilityScore(undefined)).toBeNull()
  })

  it('returns null below the minimum number of observed attempts', () => {
    const belowMin = record({
      byTool: { write_file: { successes: MIN_ATTEMPTS_FOR_RELIABILITY_SCORE - 1, errors: 0 } }
    })
    expect(computeReliabilityScore(belowMin)).toBeNull()
  })

  it('scores 100 for a perfect record once the minimum is met', () => {
    const perfect = record({
      byTool: { write_file: { successes: MIN_ATTEMPTS_FOR_RELIABILITY_SCORE, errors: 0 } }
    })
    expect(computeReliabilityScore(perfect)).toBe(100)
  })

  it('aggregates success/error counts across multiple tools', () => {
    const mixed = record({
      byTool: {
        write_file: { successes: 3, errors: 1 },
        run_command: { successes: 2, errors: 0 }
      }
    })
    // 5 successes / 6 attempts = 83.33% -> rounds to 83
    expect(computeReliabilityScore(mixed)).toBe(83)
  })

  it('subtracts a penalty per fabrication, capped so it cannot go far below the raw rate', () => {
    const withFabrications = record({
      byTool: { write_file: { successes: 5, errors: 0 } },
      fabrications: 2
    })
    // 100% success rate - (2 * 5) penalty = 90
    expect(computeReliabilityScore(withFabrications)).toBe(90)
  })

  it('never returns a score below 0 even with a low success rate and many fabrications', () => {
    const heavilyPenalized = record({
      byTool: { write_file: { successes: 1, errors: 4 } }, // 20% success rate
      fabrications: 50 // penalty caps at 30, which alone would push this negative
    })
    expect(computeReliabilityScore(heavilyPenalized)).toBe(0)
  })

  it('scores 0 for a record that only ever errors', () => {
    const allErrors = record({
      byTool: { run_command: { successes: 0, errors: MIN_ATTEMPTS_FOR_RELIABILITY_SCORE } }
    })
    expect(computeReliabilityScore(allErrors)).toBe(0)
  })
})
