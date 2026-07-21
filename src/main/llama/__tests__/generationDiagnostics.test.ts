import { describe, expect, it } from 'vitest'
import { GenerationDiagnosticsTracker } from '../generationDiagnostics'

describe('GenerationDiagnosticsTracker', () => {
  it('starts every counter at zero with no in-flight call', () => {
    const tracker = new GenerationDiagnosticsTracker()

    expect(tracker.snapshot()).toEqual({
      visibleTokens: 0,
      thoughtTokens: 0,
      functionParameterTokens: 0,
      completedToolCalls: 0,
      contextShifts: 0,
      unfinishedFunctionName: undefined,
      unfinishedFunctionParameterChars: undefined
    })
  })

  it('keeps visible, thought, and function-parameter tokens in separate buckets', () => {
    const tracker = new GenerationDiagnosticsTracker()

    tracker.recordVisibleTokens(5)
    tracker.recordThoughtTokens(20)
    tracker.recordFunctionParameterChunk(0, 'read_file_range', 7, 30)

    const snapshot = tracker.snapshot()
    expect(snapshot.visibleTokens).toBe(5)
    expect(snapshot.thoughtTokens).toBe(20)
    expect(snapshot.functionParameterTokens).toBe(7)
  })

  it('reports the in-flight call as unfinished until it settles', () => {
    const tracker = new GenerationDiagnosticsTracker()

    tracker.recordFunctionParameterChunk(0, 'list_directory', 3, 12)
    let snapshot = tracker.snapshot()
    expect(snapshot.unfinishedFunctionName).toBe('list_directory')
    expect(snapshot.unfinishedFunctionParameterChars).toBe(12)
    expect(snapshot.completedToolCalls).toBe(0)

    tracker.recordToolCallSettled()
    snapshot = tracker.snapshot()
    expect(snapshot.unfinishedFunctionName).toBeUndefined()
    expect(snapshot.unfinishedFunctionParameterChars).toBeUndefined()
    expect(snapshot.completedToolCalls).toBe(1)
  })

  it('accumulates parameter chars/tokens across multiple chunks of the same call', () => {
    const tracker = new GenerationDiagnosticsTracker()

    tracker.recordFunctionParameterChunk(0, 'read_file_range', 4, 16)
    tracker.recordFunctionParameterChunk(0, 'read_file_range', 6, 24)

    const snapshot = tracker.snapshot()
    expect(snapshot.functionParameterTokens).toBe(10)
    expect(snapshot.unfinishedFunctionName).toBe('read_file_range')
    expect(snapshot.unfinishedFunctionParameterChars).toBe(40)
  })

  it('replaces the in-flight call once a new callIndex starts streaming', () => {
    const tracker = new GenerationDiagnosticsTracker()

    tracker.recordFunctionParameterChunk(0, 'list_directory', 2, 8)
    tracker.recordToolCallSettled()
    tracker.recordFunctionParameterChunk(1, 'read_file_range', 3, 12)

    const snapshot = tracker.snapshot()
    expect(snapshot.completedToolCalls).toBe(1)
    expect(snapshot.unfinishedFunctionName).toBe('read_file_range')
    expect(snapshot.unfinishedFunctionParameterChars).toBe(12)
  })

  it('counts context shifts independently of everything else', () => {
    const tracker = new GenerationDiagnosticsTracker()

    tracker.recordContextShift()
    tracker.recordContextShift()

    expect(tracker.snapshot().contextShifts).toBe(2)
  })
})
