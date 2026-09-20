import { describe, expect, it } from 'vitest'
import { clampToBounds, positionPopover } from '../positionPopover'

/** A 1000×800 window with the usual 8px gutter and a 38px title bar. */
const bounds = { top: 46, left: 8, width: 984, height: 746 }

describe('positionPopover', () => {
  it('opens below and right-aligned to the anchor when there is room', () => {
    const anchor = { top: 100, bottom: 120, left: 200, right: 240 }
    const pos = positionPopover(anchor, { width: 200, height: 150 }, bounds)
    expect(pos).toEqual({ top: 124, left: 40 })
  })

  it('flips above the anchor when it would overflow the bottom edge', () => {
    const anchor = { top: 700, bottom: 720, left: 200, right: 240 }
    const pos = positionPopover(anchor, { width: 200, height: 150 }, bounds)
    expect(pos.top).toBe(700 - 150 - 4)
  })

  it('keeps clear of the bottom gutter when it fits neither above nor below', () => {
    const anchor = { top: 380, bottom: 400, left: 200, right: 240 }
    const pos = positionPopover(anchor, { width: 200, height: 700 }, bounds)
    expect(pos.top).toBe(92) // bottom of the bounds, minus the popover
  })

  it('never rides up under the title bar', () => {
    const anchor = { top: 50, bottom: 70, left: 200, right: 240 }
    const pos = positionPopover(anchor, { width: 200, height: 780 }, bounds)
    expect(pos.top).toBe(bounds.top)
  })

  it('falls back to the anchor left edge when right-aligning would overflow the left edge', () => {
    const anchor = { top: 100, bottom: 120, left: 10, right: 30 }
    const pos = positionPopover(anchor, { width: 200, height: 150 }, bounds)
    expect(pos.left).toBe(10)
  })

  it('clamps to the right edge when right-aligning would overflow it', () => {
    const anchor = { top: 100, bottom: 120, left: 850, right: 1100 }
    const pos = positionPopover(anchor, { width: 200, height: 150 }, bounds)
    expect(pos.left).toBe(792) // bounds.left + bounds.width - popover.width
  })

  it('left-aligns to the anchor when asked', () => {
    const anchor = { top: 100, bottom: 120, left: 200, right: 240 }
    const pos = positionPopover(anchor, { width: 200, height: 150 }, bounds, { align: 'start' })
    expect(pos.left).toBe(200)
  })

  it('opens a flyout beside its anchor, top-aligned to it', () => {
    const anchor = { top: 300, bottom: 320, left: 40, right: 200 }
    const pos = positionPopover(anchor, { width: 190, height: 120 }, bounds, {
      side: 'right',
      gap: 6
    })
    expect(pos).toEqual({ top: 300, left: 206 })
  })

  it('flips a flyout to the other side of its anchor when there is no room beside it', () => {
    const anchor = { top: 300, bottom: 320, left: 700, right: 900 }
    const pos = positionPopover(anchor, { width: 190, height: 120 }, bounds, {
      side: 'right',
      gap: 6
    })
    expect(pos.left).toBe(700 - 190 - 6)
  })

  it('slides a tall flyout up so its last row stays inside the window', () => {
    const anchor = { top: 740, bottom: 760, left: 40, right: 200 }
    const pos = positionPopover(anchor, { width: 190, height: 200 }, bounds, { side: 'right' })
    expect(pos.top).toBe(592) // bounds.top + bounds.height - 200
  })
})

describe('clampToBounds', () => {
  it('opens a menu at the pointer when it fits', () => {
    const pos = clampToBounds({ x: 300, y: 300 }, { width: 216, height: 300 }, bounds)
    expect(pos).toEqual({ top: 300, left: 300 })
  })

  it('pulls a menu back inside the bottom-right corner', () => {
    const pos = clampToBounds({ x: 960, y: 760 }, { width: 216, height: 300 }, bounds)
    expect(pos).toEqual({ top: 492, left: 776 })
  })

  it('prefers the top-left corner over overflowing when the menu is taller than the window', () => {
    const pos = clampToBounds({ x: 500, y: 700 }, { width: 216, height: 900 }, bounds)
    expect(pos).toEqual({ top: bounds.top, left: 500 })
  })
})
