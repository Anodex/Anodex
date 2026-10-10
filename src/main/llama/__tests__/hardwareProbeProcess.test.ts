import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const { probeHardwareInChild } = await import('../hardwareProbeProcess')

class FakeChild extends EventEmitter {
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('probeHardwareInChild', () => {
  it('returns what the probe process reports', async () => {
    const child = new FakeChild()
    const pending = probeHardwareInChild(() => child, 'worker.js')
    child.emit('message', {
      ok: true,
      report: { gpuNames: ['AMD Radeon RX 7900 XTX'], vram: { total: 1, unifiedSize: 0 } }
    })
    await expect(pending).resolves.toEqual({
      gpuNames: ['AMD Radeon RX 7900 XTX'],
      vram: { total: 1, unifiedSize: 0 }
    })
  })

  it('gives up, so the caller probes in-process, when the process fails or crashes', async () => {
    const failed = new FakeChild()
    const first = probeHardwareInChild(() => failed, 'worker.js')
    failed.emit('message', { ok: false, error: 'no GPU backend' })
    await expect(first).resolves.toBeNull()

    const crashed = new FakeChild()
    const second = probeHardwareInChild(() => crashed, 'worker.js')
    crashed.emit('exit', 134)
    await expect(second).resolves.toBeNull()

    const unforkable = probeHardwareInChild(() => {
      throw new Error('utility process unavailable')
    }, 'worker.js')
    await expect(unforkable).resolves.toBeNull()
  })

  it('kills a probe that hangs, and gives up', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const pending = probeHardwareInChild(() => child, 'worker.js')
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(pending).resolves.toBeNull()
    expect(child.killed).toBe(true)
  })

  it('ignores the exit that follows a good answer', async () => {
    const child = new FakeChild()
    const pending = probeHardwareInChild(() => child, 'worker.js')
    child.emit('message', { ok: true, report: { gpuNames: [], vram: null } })
    child.emit('exit', 0)
    await expect(pending).resolves.toEqual({ gpuNames: [], vram: null })
  })
})
