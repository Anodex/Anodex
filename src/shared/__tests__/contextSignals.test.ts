import { describe, expect, it } from 'vitest'
import { reconcileContextSignals } from '../contextSignals'

const signals = {
  'project-rules': 'Use strict TypeScript.',
  'active-skills': 'testing'
}

describe('reconcileContextSignals', () => {
  it('creates an initial ledger without storing signal values', () => {
    const result = reconcileContextSignals(undefined, signals, 100, 'revision-1')

    expect(result.changed).toBe(true)
    expect(result.changedKeys).toEqual(['active-skills', 'project-rules'])
    expect(result.context.ledger?.current.cause).toBe('startup')
    const fingerprints = result.context.ledger?.signalFingerprints
    expect(typeof fingerprints?.['active-skills']).toBe('string')
    expect(typeof fingerprints?.['project-rules']).toBe('string')
    expect(JSON.stringify(result.context)).not.toContain('Use strict TypeScript.')
  })

  it('reuses the same revision when signals are unchanged', () => {
    const first = reconcileContextSignals(undefined, signals, 100, 'revision-1')
    const second = reconcileContextSignals(first.context, signals, 200, 'revision-2')

    expect(second.changed).toBe(false)
    expect(second.changedKeys).toEqual([])
    expect(second.context.ledger?.current.id).toBe('revision-1')
  })

  it('advances the revision and records only changed signal keys', () => {
    const first = reconcileContextSignals(undefined, signals, 100, 'revision-1')
    const second = reconcileContextSignals(
      first.context,
      { ...signals, 'project-rules': 'Use strict TypeScript and no enums.' },
      200,
      'revision-2'
    )

    expect(second.changed).toBe(true)
    expect(second.changedKeys).toEqual(['project-rules'])
    expect(second.context.ledger?.current.id).toBe('revision-2')
    expect(second.context.ledger?.turnNotes?.at(-1)?.signalKeys).toEqual(['project-rules'])
  })
})
