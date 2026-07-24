import { describe, expect, it } from 'vitest'
import { createAsyncMutex } from '../asyncMutex'

describe('createAsyncMutex', () => {
  it('runs the second acquirer only after the first releases', async () => {
    const mutex = createAsyncMutex()

    const first = await mutex.acquire()

    let secondAcquired = false
    const secondPending = mutex.acquire().then((release) => {
      secondAcquired = true
      return release
    })

    // The second acquisition must not resolve while the first is still held.
    await Promise.resolve()
    await Promise.resolve()
    expect(secondAcquired).toBe(false)

    first()
    const secondRelease = await secondPending
    expect(secondAcquired).toBe(true)
    secondRelease()
  })

  it('serializes overlapping critical sections so they never interleave', async () => {
    // Stands in for "a generate() and a summarizeForToast() firing at once":
    // both take the model lock, and the mutex must keep only one inside its
    // critical section at a time — a broken lock would push `active` past 1.
    const mutex = createAsyncMutex()
    let active = 0
    let maxActive = 0
    const order: number[] = []

    const run = async (id: number): Promise<void> => {
      const release = await mutex.acquire()
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push(id)
      // Yield across several microtasks while "inside" the section.
      await Promise.resolve()
      await Promise.resolve()
      active -= 1
      release()
    }

    await Promise.all([run(1), run(2), run(3), run(4), run(5)])

    expect(maxActive).toBe(1)
    expect(order).toEqual([1, 2, 3, 4, 5])
  })

  it('a single release lets exactly one waiter proceed', async () => {
    const mutex = createAsyncMutex()
    const first = await mutex.acquire()

    const acquired: string[] = []
    const a = mutex.acquire().then((release) => {
      acquired.push('a')
      return release
    })
    const b = mutex.acquire().then((release) => {
      acquired.push('b')
      return release
    })

    first()
    const releaseA = await a
    expect(acquired).toEqual(['a'])

    releaseA()
    const releaseB = await b
    expect(acquired).toEqual(['a', 'b'])
    releaseB()
  })
})
