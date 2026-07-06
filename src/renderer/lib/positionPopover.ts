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

/**
 * Positions a popover against its anchor, flipping/clamping so it always
 * stays fully inside the viewport instead of getting cut off at an edge.
 * Prefers opening below the anchor, right-aligned to it (the layout every
 * dock/table popover in this app already uses); falls back to opening above
 * when there isn't room below, and clamps horizontally as a last resort.
 */
export function positionPopover(
  anchor: AnchorRect,
  popover: Size,
  viewport: Size,
  gap = 4
): { top: number; left: number } {
  let top = anchor.bottom + gap
  if (top + popover.height > viewport.height) {
    const above = anchor.top - popover.height - gap
    top = above >= 0 ? above : Math.max(0, viewport.height - popover.height)
  }

  let left = anchor.right - popover.width
  if (left < 0) left = anchor.left
  if (left + popover.width > viewport.width) left = viewport.width - popover.width
  left = Math.max(0, left)

  return { top, left }
}
