import { describe, expect, it } from 'vitest'
import type { CriticalThinkingRun } from '@shared/criticalThinking.types'
import { reconcileInterruptedCriticalThinkingRuns } from '../CriticalThinkingStore'

function makeRun(status: CriticalThinkingRun['status']): CriticalThinkingRun {
  return {
    id: 'critical_test',
    question: 'Test question',
    status,
    provider: 'local',
    model: null,
    plan: null,
    report: '',
    sources: [],
    activities: [],
    stats: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('reconcileInterruptedCriticalThinkingRuns', () => {
  it.each(['planning', 'researching'] as const)('stops an interrupted %s run', (status) => {
    const [run] = reconcileInterruptedCriticalThinkingRuns([makeRun(status)])

    expect(run.status).toBe('stopped')
    expect(run.lastError).toContain('app restarted')
  })

  it.each(['needs-review', 'done', 'stopped', 'error'] as const)(
    'leaves a %s run unchanged',
    (status) => {
      const original = makeRun(status)
      const [run] = reconcileInterruptedCriticalThinkingRuns([original])

      expect(run).toBe(original)
    }
  )
})
