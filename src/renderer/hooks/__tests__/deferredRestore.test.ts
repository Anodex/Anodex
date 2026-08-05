import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeferredRestore } from '../deferredRestore'

/**
 * The timer behind the deferred model restore at startup. It exists because an
 * untracked `setTimeout` once fired the restore twice, and two concurrent
 * `loadModel()` calls racing for the same GPU and model resources was the
 * intermittent native startup crash.
 */

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DeferredRestore', () => {
  it('runs the restore once the delay has passed', () => {
    const restore = new DeferredRestore()
    const run = vi.fn()

    restore.schedule(run, 3_000)
    vi.advanceTimersByTime(3_000)

    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not run it early', () => {
    const restore = new DeferredRestore()
    const run = vi.fn()

    restore.schedule(run, 3_000)
    vi.advanceTimersByTime(2_999)

    expect(run).not.toHaveBeenCalled()
  })

  it('never runs twice when scheduled twice', () => {
    // The crash this exists to prevent: two paths can schedule a restore — the
    // bridge effect on mount and `retryStartup` — and two `loadModel()` calls
    // racing for the same engine is what took the app down.
    const restore = new DeferredRestore()
    const run = vi.fn()

    restore.schedule(run, 3_000)
    restore.schedule(run, 3_000)
    vi.advanceTimersByTime(10_000)

    expect(run).toHaveBeenCalledTimes(1)
  })

  it('measures the delay from the most recent schedule', () => {
    const restore = new DeferredRestore()
    const run = vi.fn()

    restore.schedule(run, 3_000)
    vi.advanceTimersByTime(2_000)
    restore.schedule(run, 3_000)
    vi.advanceTimersByTime(2_000)

    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not run after being cancelled', () => {
    // Cleanup has to be able to stop it, or a restore fires into an app that
    // is closing.
    const restore = new DeferredRestore()
    const run = vi.fn()

    restore.schedule(run, 3_000)
    restore.cancel()
    vi.advanceTimersByTime(10_000)

    expect(run).not.toHaveBeenCalled()
  })

  it('is safe to cancel when nothing is pending', () => {
    const restore = new DeferredRestore()

    expect(() => {
      restore.cancel()
      restore.cancel()
    }).not.toThrow()
  })

  it('reports nothing pending once it has run', () => {
    const restore = new DeferredRestore()

    restore.schedule(() => {}, 3_000)
    expect(restore.pending).toBe(true)
    vi.advanceTimersByTime(3_000)

    expect(restore.pending).toBe(false)
  })
})

describe('the bridge schedules its restore through the shared timer', () => {
  /**
   * A structural guard, in the style of `ipcContract.test.ts`: the hook itself
   * needs a DOM to exercise, and renderer tests run under `environment: 'node'`
   * with no jsdom. What can still be asserted is that neither path reintroduces
   * a bare `setTimeout` — which is the whole defect, since an untracked one
   * cannot be cancelled and can overlap a second.
   */
  it('leaves no untracked timer scheduling a model restore', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/renderer/hooks/useAnodexBridge.ts', 'utf-8')

    expect(source).not.toMatch(/setTimeout\s*\(\s*\(\)\s*=>\s*void restoreLastModel/)
    // Both paths — the mount effect and `retryStartup` — go through the shared
    // handle, so a duplicate schedule replaces rather than races.
    expect(source.match(/deferredModelRestore\.schedule\(/g)).toHaveLength(2)
    expect(source).toContain('deferredModelRestore.cancel()')
  })
})
