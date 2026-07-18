import { beforeEach, describe, expect, it } from 'vitest'
import {
  abortAllGenerations,
  abortGeneration,
  registerGeneration,
  releaseGeneration
} from '../inflightGenerations'

describe('inflightGenerations', () => {
  beforeEach(() => {
    abortAllGenerations()
  })

  it('aborts the registered controller for a conversation', () => {
    const controller = new AbortController()
    registerGeneration('c1', controller)

    abortGeneration('c1')

    expect(controller.signal.aborted).toBe(true)
  })

  it('is a no-op for a conversation with nothing in flight', () => {
    expect(() => abortGeneration('missing')).not.toThrow()
  })

  it('aborts the prior controller when a second one registers for the same conversation', () => {
    const first = new AbortController()
    const second = new AbortController()
    registerGeneration('c1', first)
    registerGeneration('c1', second)

    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
  })

  it('release only clears the slot if the controller is still the one registered', () => {
    const first = new AbortController()
    const second = new AbortController()
    registerGeneration('c1', first)
    // Simulate an overlapping send replacing the slot before the first
    // generation's own cleanup runs.
    registerGeneration('c1', second)

    releaseGeneration('c1', first)
    // The slot should still hold `second` — releasing a stale controller
    // must not clear a newer, still-running one.
    abortGeneration('c1')
    expect(second.signal.aborted).toBe(true)
  })

  it('abortAllGenerations aborts every registered conversation and clears the map', () => {
    const a = new AbortController()
    const b = new AbortController()
    registerGeneration('a', a)
    registerGeneration('b', b)

    abortAllGenerations()

    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
  })
})
