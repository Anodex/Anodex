/**
 * Whether a local model is running in a much smaller context than the machine
 * could give it.
 *
 * Anodex already works the answer out — `contextSizeFor` maps hardware to a
 * context size, and it is what the first-run recommendation uses. Nothing
 * revisits it. A window set once, or set deliberately for a test, stays set,
 * and the only visible sign is a context meter reading "8.2K", which looks
 * like a fact about the model rather than a choice about the machine.
 *
 * Measured on one machine (2026-09-05): a 27B ran at 8,192 while
 * `contextSizeFor` put it at 32,768 for 63 GB of RAM and 24 GB of VRAM. The
 * cost was not subtle. A Critical Thinking run there read 5,725 characters of
 * the 56,528 it had gathered; at the larger window the same question read
 * 56,021 of 130,472 and produced the best report on record. The agent suite
 * scored 1 of 6 at the small window against 6 of 6 at the large one.
 *
 * Cloud models need none of this: their window is a property of the model, and
 * `cloudContextWindowTokens` already reads it from the catalog. This is only
 * for local, where the window is a setting the user pays for in memory.
 */
export interface ContextHeadroom {
  /** What the model is running at now. */
  configured: number
  /** What this machine could support, from `contextSizeFor`. */
  recommended: number
  /**
   * Whether the gap is large enough to be worth a line of interface.
   *
   * Doubling is the bar. Below it the difference is real but not
   * transformative, and a prompt the user cannot act on usefully is a prompt
   * that teaches them to ignore the next one. The measured case is 4x.
   */
  worthMentioning: boolean
}

/** Below this multiple the difference is not worth interrupting anyone for. */
const MENTION_RATIO = 2

export function contextHeadroom(
  configured: number | undefined,
  recommended: number | undefined
): ContextHeadroom | null {
  if (!configured || !recommended || configured <= 0 || recommended <= 0) return null
  return {
    configured,
    recommended,
    worthMentioning: recommended >= configured * MENTION_RATIO
  }
}
