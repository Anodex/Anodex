export interface AnchorRect {
  top: number
  bottom: number
  left: number
  right: number
}

export interface Size {
  width: number
  height: number
}

/** A rectangle a floating layer must stay inside, in viewport coordinates. */
export interface Bounds {
  top: number
  left: number
  width: number
  height: number
}

export interface PlacementOptions {
  /** Space left between the anchor and the popover. */
  gap?: number
  /** Which edge of the anchor the popover lines up with horizontally. */
  align?: 'start' | 'end'
  /** Preferred side: below the anchor, or beside it (a flyout). */
  side?: 'bottom' | 'right'
}

/** How close to an edge of the window a floating layer may come. */
const EDGE_GUTTER = 8
const DEFAULT_GAP = 4

function titleBarHeight(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--titlebar-height')
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : 0
}

/**
 * The part of the Anodex window a menu, popover or card may occupy: the frame
 * minus a gutter, and minus the title bar — which is a window drag region, so
 * a menu laid over it would be a menu you cannot click without moving the
 * window.
 *
 * Read from the live window rather than passed in, because every caller wants
 * the same answer and the point of this module is that no floating layer
 * invents its own idea of where the edges are.
 */
export function windowBounds(gutter = EDGE_GUTTER): Bounds {
  const titleBar = titleBarHeight()
  return {
    top: titleBar + gutter,
    left: gutter,
    width: Math.max(0, window.innerWidth - gutter * 2),
    height: Math.max(0, window.innerHeight - titleBar - gutter * 2)
  }
}

/** Slides a span of `size` starting at `start` back inside `[min, min + extent]`. */
function fit(start: number, size: number, min: number, extent: number): number {
  const end = min + extent
  const shifted = start + size > end ? end - size : start
  return Math.max(min, shifted)
}

/**
 * Positions a popover against its anchor, flipping and clamping so it always
 * stays fully inside `bounds` instead of getting cut off at a window edge.
 * Prefers opening below the anchor, right-aligned to it (the layout every
 * dock/table popover in this app already uses); falls back to opening above
 * when there isn't room below, and clamps as a last resort.
 */
export function positionPopover(
  anchor: AnchorRect,
  popover: Size,
  bounds: Bounds,
  options: PlacementOptions = {}
): { top: number; left: number } {
  const { gap = DEFAULT_GAP, align = 'end', side = 'bottom' } = options

  if (side === 'right') {
    let left = anchor.right + gap
    if (left + popover.width > bounds.left + bounds.width) {
      const before = anchor.left - popover.width - gap
      if (before >= bounds.left) left = before
    }
    return {
      top: fit(anchor.top, popover.height, bounds.top, bounds.height),
      left: fit(left, popover.width, bounds.left, bounds.width)
    }
  }

  let top = anchor.bottom + gap
  if (top + popover.height > bounds.top + bounds.height) {
    const above = anchor.top - popover.height - gap
    if (above >= bounds.top) top = above
  }

  let left = align === 'end' ? anchor.right - popover.width : anchor.left
  // Right-aligning a popover wider than its anchor can push it off the left
  // edge; line it up with the anchor's other edge before resorting to a clamp.
  if (left < bounds.left && align === 'end') left = anchor.left

  return {
    top: fit(top, popover.height, bounds.top, bounds.height),
    left: fit(left, popover.width, bounds.left, bounds.width)
  }
}

/**
 * Places a layer opened at a point rather than against an element — a
 * right-click menu — keeping it inside `bounds`. Clamped rather than flipped:
 * the menu stays under the cursor that opened it.
 */
export function clampToBounds(
  point: { x: number; y: number },
  size: Size,
  bounds: Bounds
): { top: number; left: number } {
  return {
    top: fit(point.y, size.height, bounds.top, bounds.height),
    left: fit(point.x, size.width, bounds.left, bounds.width)
  }
}
