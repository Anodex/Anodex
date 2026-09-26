import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { describeStall, SILENCE_LIMIT_MS, watchForStall } from '../streamStall'

/**
 * llama-server wedged mid-run and Anodex waited nineteen minutes on a request
 * whose own fifteen-minute timeout could not fire — that timeout bounds
 * getting the response, and nothing bounded the gaps between chunks once the
 * stream was open. The whole app went with it: `isGenerating()` stayed true,
 * so the Scheduler deferred every due task forever.
 */
describe('watchForStall', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts once nothing has arrived for the limit', () => {
    const watch = watchForStall(undefined)
    expect(watch.signal.aborted).toBe(false)

    vi.advanceTimersByTime(SILENCE_LIMIT_MS - 1)
    expect(watch.signal.aborted).toBe(false)

    vi.advanceTimersByTime(1)
    expect(watch.signal.aborted).toBe(true)
    expect(watch.stalled).toBe(true)
  })

  it('never abandons a slow stream that is still talking', () => {
    const watch = watchForStall(undefined)
    // A reply that takes an hour, saying something every four minutes.
    for (let minute = 0; minute < 60; minute += 4) {
      vi.advanceTimersByTime(4 * 60_000)
      watch.heard()
    }
    expect(watch.signal.aborted).toBe(false)
    expect(watch.stalled).toBe(false)
  })

  it('starts the clock again from the last chunk, not from the request', () => {
    const watch = watchForStall(undefined)
    vi.advanceTimersByTime(SILENCE_LIMIT_MS - 1_000)
    watch.heard()
    vi.advanceTimersByTime(SILENCE_LIMIT_MS - 1_000)
    expect(watch.signal.aborted).toBe(false)
  })

  it('stops watching once the stream is done', () => {
    const watch = watchForStall(undefined)
    watch.done()
    vi.advanceTimersByTime(SILENCE_LIMIT_MS * 3)
    expect(watch.signal.aborted).toBe(false)
    expect(watch.stalled).toBe(false)
  })

  it("passes the caller's abort through without calling it a stall", () => {
    const caller = new AbortController()
    const watch = watchForStall(caller.signal)

    caller.abort()

    expect(watch.signal.aborted).toBe(true)
    // The turn has to be able to tell "the user stopped this" from "the
    // runtime died", or a wedge is reported as a user action and nothing in
    // the log says otherwise.
    expect(watch.stalled).toBe(false)
  })

  it('handles a caller that had already aborted', () => {
    const caller = new AbortController()
    caller.abort()
    const watch = watchForStall(caller.signal)
    expect(watch.signal.aborted).toBe(true)
    expect(watch.stalled).toBe(false)
  })

  it('honours a custom limit', () => {
    const watch = watchForStall(undefined, 1_000)
    vi.advanceTimersByTime(1_000)
    expect(watch.stalled).toBe(true)
  })

  it('says how long it waited, in minutes', () => {
    expect(describeStall()).toContain('5 minutes')
    expect(describeStall(120_000)).toContain('2 minutes')
  })

  it('leaves the silence limit well clear of a cold prompt read', () => {
    // The longest legitimate gap is reading a cold prompt before the first
    // token: a 128k window at the ~700 tok/s this hardware manages is about
    // three minutes, and llama-server streams progress through it anyway.
    const worstHonestGapMs = (131_072 / 700) * 1_000
    expect(SILENCE_LIMIT_MS).toBeGreaterThan(worstHonestGapMs)
  })
})

/**
 * One watch is created per round and they all listen to the same turn-long
 * abort signal, so a listener that never fires is a listener that accumulates.
 * A 65k turn now gets 48 rounds; Node starts warning about a leak past ten.
 */
describe('watchForStall listener hygiene', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves nothing listening on the turn signal after a round ends', () => {
    const caller = new AbortController()
    const added: unknown[] = []
    const removed: unknown[] = []
    const realAdd = caller.signal.addEventListener.bind(caller.signal)
    const realRemove = caller.signal.removeEventListener.bind(caller.signal)
    caller.signal.addEventListener = (type, listener, options): void => {
      if (type === 'abort') added.push(listener)
      realAdd(type, listener, options)
    }
    caller.signal.removeEventListener = (type, listener, options): void => {
      if (type === 'abort') removed.push(listener)
      realRemove(type, listener, options)
    }

    for (let round = 0; round < 48; round++) {
      watchForStall(caller.signal).done()
    }

    expect(added).toHaveLength(48)
    expect(removed).toHaveLength(48)
  })

  it('still relays the caller abort while the round is live', () => {
    const caller = new AbortController()
    const watch = watchForStall(caller.signal)
    caller.abort()
    expect(watch.signal.aborted).toBe(true)
    expect(watch.stalled).toBe(false)
    watch.done()
  })
})
