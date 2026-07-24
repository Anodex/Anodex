import { describe, expect, it } from 'vitest'
import { changeImageZoom } from '../imageLightboxZoom'

describe('changeImageZoom', () => {
  it('moves through the supported zoom levels', () => {
    expect(changeImageZoom(1, 1)).toBe(1.25)
    expect(changeImageZoom(1, -1)).toBe(0.75)
    expect(changeImageZoom(1.25, 1)).toBe(1.5)
  })

  it('stays within the minimum and maximum zoom', () => {
    expect(changeImageZoom(0.5, -1)).toBe(0.5)
    expect(changeImageZoom(3, 1)).toBe(3)
  })
})
