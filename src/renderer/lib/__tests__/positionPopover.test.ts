import { describe, expect, it } from 'vitest'
import { positionPopover } from '../positionPopover'

const viewport = { width: 1000, height: 800 }

describe('positionPopover', () => {
  it('opens below and right-aligned to the anchor when there is room', () => {
    const anchor = { top: 100, bottom: 120, left: 200, right: 240 }
    const pos = positionPopover(anchor, { width: 200, height: 150 }, viewport)
    expect(pos).toEqual({ top: 124, left: 40 })
  })

  it('flips above the anchor when it would overflow the bottom edge', () => {
    const anchor = { top: 700, bottom: 720, left: 200, right: 240 }
    const pos = positionPopover(anchor, { width: 200, height: 150 }, viewport)
    expect(pos.top).toBe(700 - 150 - 4)
  })

  it('clamps to the top of the viewport if it overflows both above and below', () => {
    const anchor = { top: 50, bottom: 70, left: 200, right: 240 }
    const pos = positionPopover(anchor, { width: 200, height: 780 }, viewport)
    expect(pos.top).toBe(20) // viewport.height - popover.height
  })

  it('falls back to the anchor left edge when right-aligning would overflow the left edge', () => {
    const anchor = { top: 100, bottom: 120, left: 10, right: 30 }
    const pos = positionPopover(anchor, { width: 200, height: 150 }, viewport)
    expect(pos.left).toBe(10)
  })

  it('clamps to the right edge of the viewport when right-aligning would overflow it', () => {
    const anchor = { top: 100, bottom: 120, left: 850, right: 1100 }
    const pos = positionPopover(anchor, { width: 200, height: 150 }, viewport)
    expect(pos.left).toBe(800) // viewport.width - popover.width
  })
})
