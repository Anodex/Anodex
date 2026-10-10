import { describe, expect, it, vi } from 'vitest'
import { lazyImport } from '../lazyImport'

describe('lazyImport', () => {
  it('loads nothing until asked, then loads once however often it is asked', async () => {
    const load = vi.fn().mockResolvedValue({ name: 'sdk' })
    const get = lazyImport(load)
    expect(load).not.toHaveBeenCalled()
    expect(get.loaded()).toBeUndefined()

    const [a, b] = await Promise.all([get(), get()])
    expect(a).toBe(b)
    expect(load).toHaveBeenCalledTimes(1)
    expect(get.loaded()).toEqual({ name: 'sdk' })
  })

  it('tries again after a failed load instead of failing for ever', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('EBUSY'))
      .mockResolvedValueOnce({ name: 'sdk' })
    const get = lazyImport(load)

    await expect(get()).rejects.toThrow('EBUSY')
    expect(get.loaded()).toBeUndefined()
    await expect(get()).resolves.toEqual({ name: 'sdk' })
  })
})
