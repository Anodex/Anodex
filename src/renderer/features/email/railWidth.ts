/**
 * How wide the assistant rail is, and how far the user is allowed to take it.
 *
 * The rail is dragged, not toggled between presets, so the bounds are the only
 * thing keeping it honest: it exists to sit *beside* the mail, and a rail
 * dragged across most of the pane has quietly turned back into the Chat page
 * with an email behind it.
 */

const STORAGE_KEY = 'anodex.email.rail-width'

/** Comfortable for a summary and a couple of exchanges without dominating. */
export const DEFAULT_RAIL_WIDTH = 380

/** Below this the composer's own controls start wrapping. */
export const MIN_RAIL_WIDTH = 300

/**
 * The reader's floor. Dragging never takes the mail below this, which is what
 * stops the rail eating the thread it is supposed to be discussing — the mail
 * gives up width until it reaches this, and then the drag simply stops.
 */
export const MIN_READER_WIDTH = 460

/** Neither pane may take more than this share, however much room there is. */
const MAX_RAIL_SHARE = 0.55

/**
 * The widest the rail may be in a panel this wide.
 *
 * Both limits matter and the tighter one wins: the share keeps the rail from
 * dominating a large display, and the reader floor keeps it from crushing the
 * mail on a small one.
 */
export function maxRailWidth(panelWidth: number): number {
  const byShare = panelWidth * MAX_RAIL_SHARE
  const byReader = panelWidth - MIN_READER_WIDTH
  // Never returns less than the minimum: on a panel too narrow for both panes
  // the rail keeps its floor and the reader scrolls, rather than the bounds
  // inverting and the clamp snapping the rail shut.
  return Math.max(MIN_RAIL_WIDTH, Math.min(byShare, byReader))
}

/** The nearest width to `width` that the panel actually allows. */
export function clampRailWidth(width: number, panelWidth: number): number {
  if (!Number.isFinite(width)) return DEFAULT_RAIL_WIDTH
  // A panel that has not been measured yet (width 0 before the first layout)
  // must not clamp anything to its floor — leave the value alone until there
  // is a real width to judge it against.
  if (panelWidth <= 0) return Math.round(Math.max(width, MIN_RAIL_WIDTH))
  return Math.round(Math.min(Math.max(width, MIN_RAIL_WIDTH), maxRailWidth(panelWidth)))
}

/** The width the user last dragged to, or the default on a first run. */
export function loadRailWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_RAIL_WIDTH
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? Math.max(parsed, MIN_RAIL_WIDTH) : DEFAULT_RAIL_WIDTH
  } catch {
    return DEFAULT_RAIL_WIDTH
  }
}

export function saveRailWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(width)))
  } catch {
    /* Private mode, or storage full — the rail just forgets its width. */
  }
}
