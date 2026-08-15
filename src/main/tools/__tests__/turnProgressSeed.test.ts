import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@shared/tools.types'
import {
  createTurnProgress,
  hasPostChangeVisualEvidence,
  progressFromSettledCalls,
  recordCompletedCall
} from '../turnProgress'

function call(overrides: Partial<ToolCall> & Pick<ToolCall, 'name' | 'kind'>): ToolCall {
  return {
    id: overrides.name,
    title: overrides.name,
    status: 'success',
    ...overrides
  }
}

describe('createTurnProgress seeding across a context epoch', () => {
  it('starts empty without a seed, exactly as an ordinary turn does', () => {
    expect(createTurnProgress()).toEqual({
      madeChange: false,
      completedCalls: 0,
      lastChangeAt: null,
      lastVisualInspectionAt: null
    })
  })

  it('carries the counter forward so a new call is not ordered before a carried change', () => {
    // Seeding the sequence values while restarting the counter at zero would
    // make this epoch's first call (sequence 1) compare as older than the
    // carried change at 12, and `hasPostChangeVisualEvidence` could then never
    // return true again for the rest of the task.
    const progress = createTurnProgress({
      madeChange: true,
      completedCalls: 0,
      lastChangeAt: 12,
      lastVisualInspectionAt: null
    })
    expect(progress.completedCalls).toBe(12)

    recordCompletedCall(progress, { name: 'inspect_visual', kind: 'read' })
    expect(progress.lastVisualInspectionAt).toBe(13)
    expect(hasPostChangeVisualEvidence(progress)).toBe(true)
  })

  it('still demands fresh evidence when the carried change has not been inspected', () => {
    const progress = createTurnProgress({
      madeChange: true,
      completedCalls: 12,
      lastChangeAt: 12,
      lastVisualInspectionAt: 4
    })
    expect(hasPostChangeVisualEvidence(progress)).toBe(false)
  })

  it('carries madeChange so completed work is not required to be redone', () => {
    // Without this the resumed epoch is told "Nothing has been done yet this
    // turn" and instructed to mutate again to prove work that already happened.
    const progress = createTurnProgress({
      madeChange: true,
      completedCalls: 3,
      lastChangeAt: 3,
      lastVisualInspectionAt: null
    })
    expect(progress.madeChange).toBe(true)
  })
})

describe('progressFromSettledCalls', () => {
  it('reproduces the live ledger from a reply’s settled calls', () => {
    const progress = progressFromSettledCalls([
      call({ name: 'read_file', kind: 'read' }),
      call({ name: 'write_file', kind: 'write' }),
      call({ name: 'inspect_visual', kind: 'read' })
    ])
    expect(progress).toEqual({
      madeChange: true,
      completedCalls: 3,
      lastChangeAt: 2,
      lastVisualInspectionAt: 3
    })
    expect(hasPostChangeVisualEvidence(progress)).toBe(true)
  })

  it('ignores calls that did not succeed', () => {
    const progress = progressFromSettledCalls([
      call({ name: 'write_file', kind: 'write', status: 'error' }),
      call({ name: 'run_command', kind: 'command', status: 'denied' })
    ])
    expect(progress).toEqual({
      madeChange: false,
      completedCalls: 0,
      lastChangeAt: null,
      lastVisualInspectionAt: null
    })
  })

  it('ignores successful calls that explicitly report no durable progress', () => {
    const progress = progressFromSettledCalls([
      call({ name: 'read_file', kind: 'read', madeProgress: false }),
      call({ name: 'write_plan', kind: 'plan', madeProgress: false })
    ])
    expect(progress).toEqual({
      madeChange: false,
      completedCalls: 0,
      lastChangeAt: null,
      lastVisualInspectionAt: null
    })
  })

  it('does not let reading or planning count as carrying out the goal', () => {
    const progress = progressFromSettledCalls([
      call({ name: 'read_file', kind: 'read' }),
      call({ name: 'write_plan', kind: 'plan' })
    ])
    expect(progress.madeChange).toBe(false)
  })
})
