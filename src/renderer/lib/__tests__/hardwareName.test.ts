import { describe, expect, it } from 'vitest'
import { shortHardwareName } from '../hardwareName'

describe('shortHardwareName', () => {
  it('drops the filler the OS adds around a chip name', () => {
    expect(shortHardwareName('AMD Ryzen 9 5900X 12-Core Processor')).toBe('AMD Ryzen 9 5900X')
    expect(shortHardwareName('Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz')).toBe(
      'Intel Core i7-9750H'
    )
    expect(shortHardwareName('AMD Radeon RX 6800 (radeonsi, navi21, LLVM 17.0.6, DRM 3.57)')).toBe(
      'AMD Radeon RX 6800'
    )
  })

  it('leaves a name with nothing to trim alone', () => {
    expect(shortHardwareName('Apple M2 Pro')).toBe('Apple M2 Pro')
    expect(shortHardwareName('NVIDIA GeForce RTX 4070')).toBe('NVIDIA GeForce RTX 4070')
  })
})
