import { describe, expect, it } from 'vitest'
import { createModelGate } from '../modelGate'

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** Several jobs on one loaded model, and loads that must have it alone. */
describe('createModelGate', () => {
  it('with capacity 1, runs one job at a time in order', async () => {
    const gate = createModelGate(1)
    const order: string[] = []

    const first = await gate.acquire()
    const second = gate.acquire().then((release) => {
      order.push('second')
      return release
    })
    await settle()
    expect(order).toEqual([])
    expect(gate.waiting()).toBe(1)

    first()
    ;(await second)()
    expect(order).toEqual(['second'])
    expect(gate.waiting()).toBe(0)
  })

  it('runs up to capacity jobs together, and queues the rest', async () => {
    const gate = createModelGate(2)
    const a = await gate.acquire()
    const b = await gate.acquire()

    let thirdIn = false
    const third = gate.acquire().then((release) => {
      thirdIn = true
      return release
    })
    await settle()
    expect(thirdIn).toBe(false)

    a()
    ;(await third)()
    expect(thirdIn).toBe(true)
    b()
  })

  it('makes a load wait for running jobs, and keeps new jobs out until it is done', async () => {
    const gate = createModelGate(3)
    const job = await gate.acquire()

    let loading = false
    const load = gate.acquireExclusive().then((release) => {
      loading = true
      return release
    })
    let laterJobIn = false
    const laterJob = gate.acquire().then((release) => {
      laterJobIn = true
      return release
    })
    await settle()
    // Room for more jobs, but the load asked first: nothing overtakes it.
    expect(loading).toBe(false)
    expect(laterJobIn).toBe(false)

    job()
    const releaseLoad = await load
    await settle()
    expect(loading).toBe(true)
    expect(laterJobIn).toBe(false)

    releaseLoad()
    ;(await laterJob)()
    expect(laterJobIn).toBe(true)
  })

  it('lets queued jobs in when capacity grows', async () => {
    const gate = createModelGate(1)
    const first = await gate.acquire()
    let secondIn = false
    const second = gate.acquire().then((release) => {
      secondIn = true
      return release
    })
    await settle()
    expect(secondIn).toBe(false)

    gate.setCapacity(2)
    ;(await second)()
    expect(secondIn).toBe(true)
    first()
  })

  it('ignores a second release of the same slot', async () => {
    const gate = createModelGate(1)
    const first = await gate.acquire()
    first()
    const second = await gate.acquire()
    first()
    let thirdIn = false
    void gate.acquire().then(() => {
      thirdIn = true
    })
    await settle()
    expect(thirdIn).toBe(false)
    second()
  })
})
