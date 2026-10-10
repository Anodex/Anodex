import { describe, expect, it } from 'vitest'
import type { RecommendedModel } from '@shared/recommendedModels'
import { downloadShortfallBytes } from '../diskSpace'

const GB = 1024 ** 3
const model = { approxSize: '21.5 GB', minRamGb: 29 } as RecommendedModel

describe('downloadShortfallBytes', () => {
  // The clean-install screenshot: 19.8 GB free, a 21.5 GB model, and
  // "Download and load" offered anyway.
  it('reports how far short the drive is', () => {
    const short = downloadShortfallBytes({ storageFreeBytes: 19.8 * GB }, model)
    expect(short / GB).toBeGreaterThan(1.7)
    expect(short / GB).toBeLessThan(2.3)
  })

  it('is zero when the model fits with room to spare', () => {
    expect(downloadShortfallBytes({ storageFreeBytes: 340 * GB }, model)).toBe(0)
  })

  it('wants a little headroom beyond the exact size', () => {
    expect(downloadShortfallBytes({ storageFreeBytes: 21.5 * GB }, model)).toBeGreaterThan(0)
  })

  it('lets a machine that cannot report free space still try', () => {
    expect(downloadShortfallBytes({ storageFreeBytes: null }, model)).toBe(0)
    expect(downloadShortfallBytes(null, model)).toBe(0)
  })

  it('does not ask for room again for what a stopped download already kept', () => {
    expect(downloadShortfallBytes({ storageFreeBytes: 10 * GB }, model)).toBeGreaterThan(0)
    expect(downloadShortfallBytes({ storageFreeBytes: 10 * GB }, model, 15 * GB)).toBe(0)
  })
})
