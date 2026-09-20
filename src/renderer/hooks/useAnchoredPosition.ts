import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import {
  clampToBounds,
  positionPopover,
  windowBounds,
  type AnchorRect,
  type PlacementOptions
} from '../lib/positionPopover'

/** Either the element a layer hangs off, or the point it was opened at. */
export type Anchor = AnchorRect | { x: number; y: number }

/**
 * Places a floating layer — a menu, a flyout, a hover card — inside the Anodex
 * window.
 *
 * The layer is rendered first and measured after, so nothing has to guess its
 * size: a guessed height is how a menu ends up half off the bottom of the
 * window the moment someone adds a row to it. Until it has been measured the
 * returned style hides it, which costs one frame and avoids a visible jump.
 *
 * Pass `null` as the anchor while the layer is closed.
 */
export function useAnchoredPosition(
  anchor: Anchor | null,
  floating: RefObject<HTMLElement | null>,
  options: PlacementOptions = {}
): CSSProperties {
  const { gap, align, side } = options
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  // Placement re-runs when the anchor *moves*, not when a caller happens to
  // build the same rectangle again: an anchor written inline is a new object
  // every render, and depending on its identity would re-place the layer on
  // every render it causes.
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor
  const anchorKey = anchor
    ? 'x' in anchor
      ? `${anchor.x},${anchor.y}`
      : `${anchor.top},${anchor.bottom},${anchor.left},${anchor.right}`
    : null

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) {
      setPosition(null)
      return
    }
    const element = floating.current
    if (!element) return
    const size = { width: element.offsetWidth, height: element.offsetHeight }
    const bounds = windowBounds()
    setPosition(
      'x' in anchor
        ? clampToBounds(anchor, size, bounds)
        : positionPopover(anchor, size, bounds, { gap, align, side })
    )
  }, [anchorKey, floating, gap, align, side])

  return position
    ? { top: position.top, left: position.left, visibility: 'visible' }
    : { top: 0, left: 0, visibility: 'hidden' }
}
