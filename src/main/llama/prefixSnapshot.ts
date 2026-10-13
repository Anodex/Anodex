/**
 * Where to snapshot a hybrid or recurrent model's sequence so a new
 * conversation can start from the prompt every conversation shares.
 *
 * ## Why this exists
 *
 * A transformer's KV cache can be cut back to any token, so when a new chat
 * opens with the same system prompt as the last one, node-llama-cpp keeps that
 * prefix and reads only what differs. A hybrid model (Qwen3.6/3.8, Granite H,
 * Falcon-H1, LFM2, Mamba) also carries a recurrent state that cannot be cut
 * back. It can only be restored from a checkpoint, and node-llama-cpp takes
 * those at the end of a prompt and of a reply, which is always past the point
 * where two chats differ. So without a checkpoint at the end of the shared
 * part, every new chat on a hybrid model reads the whole ~3,000-token system
 * prompt again: about 30 s before the first word on an integrated GPU.
 *
 * Each cut is found the same way: render the history twice through the real
 * chat wrapper with one thing changed, and see where the tokens part. That
 * holds for any template without knowing its syntax. The things changed are:
 *
 * - the Environment clock, stated to the minute, so it is the first place two
 *   conversations differ at all (`withEnvironmentClockMasked`);
 * - the tool documentation, which the next chat may route differently;
 * - the user's message, the end of what this turn shares with any other.
 *
 * Measured on Qwen3.6-14B-A3B with Anodex's chat prompt: the clock sits about
 * 1,600 tokens in, the tools about 1,900, the user message about 2,900.
 */

/** Two probe messages that share no first character, so their renderings part at the user text. */
export const PREFIX_PROBE_MESSAGES = ['a', 'Z'] as const

/**
 * Tokens left out before each cut. A real message can merge with the template
 * text just before it differently from a one-letter probe; backing off a few
 * tokens keeps the snapshot inside text every rendering agrees on.
 */
const BOUNDARY_MARGIN_TOKENS = 4

/** Below this a snapshot saves too little reading to be worth its memory. */
const MIN_SNAPSHOT_TOKENS = 256

/** Two cuts closer than this would cost a second snapshot for almost nothing. */
const MIN_CUT_SPACING_TOKENS = 128

/**
 * How much of an opening prompt is read between two checks for Stop.
 *
 * node-llama-cpp does not look at the abort signal while it reads a prompt, so a
 * reply could not be stopped, and the app could not quit cleanly, until the
 * whole prompt had been read: 35–40 s on an integrated GPU. Read in pieces this
 * size, a stop lands within one piece (about 3 s at the ~90 tokens/s an Iris Xe
 * reads at). Smaller pieces gave no faster stop worth the lost batching.
 */
export const READ_PIECE_TOKENS = 256

/** One piece of reading: up to `end` (exclusive), then a checkpoint if `checkpoint`. */
export interface ReadStep {
  end: number
  checkpoint: boolean
}

/**
 * The pieces that read tokens `from` up to `to`, none longer than `piece`, each
 * snapshot cut in between ending a piece of its own so the checkpoint lands
 * exactly on it.
 */
export function readSteps(
  from: number,
  to: number,
  cuts: readonly number[],
  piece: number = READ_PIECE_TOKENS
): ReadStep[] {
  const steps: ReadStep[] = []
  const stops = [...new Set(cuts.filter((cut) => cut > from && cut < to))].sort((a, b) => a - b)
  let position = from
  for (const boundary of [...stops, to]) {
    while (position < boundary) {
      position = Math.min(position + piece, boundary)
      steps.push({ end: position, checkpoint: position === boundary && boundary !== to })
    }
  }
  return steps
}

/** How many leading tokens `a` and `b` have in common. */
export function sharedPrefixLength(a: readonly number[], b: readonly number[]): number {
  const limit = Math.min(a.length, b.length)
  let index = 0
  while (index < limit && a[index] === b[index]) index++
  return index
}

/**
 * The token counts to snapshot at, ascending, each a prefix of `withTools`.
 *
 * - `withTools`: the history rendered with the first probe and this turn's tools.
 * - `withoutTools`: the same with no tools.
 * - `withToolsOtherProbe`: the same with tools and the second probe.
 * - `withClockMasked`: the same with tools and the Environment clock masked, or
 *   absent when the system prompt states no clock.
 */
export function prefixSnapshotCuts(renders: {
  withTools: readonly number[]
  withoutTools: readonly number[]
  withToolsOtherProbe: readonly number[]
  withClockMasked?: readonly number[]
}): number[] {
  const candidates = [
    // Where the clock begins: every later token can differ by the next minute.
    ...(renders.withClockMasked
      ? [sharedPrefixLength(renders.withTools, renders.withClockMasked)]
      : []),
    // Where the tool documentation begins (or the user turn, with no tools).
    sharedPrefixLength(renders.withoutTools, renders.withTools),
    // Where this turn's user message begins.
    sharedPrefixLength(renders.withTools, renders.withToolsOtherProbe)
  ]
    .map((length) => length - BOUNDARY_MARGIN_TOKENS)
    .filter((cut) => cut >= MIN_SNAPSHOT_TOKENS)
    .sort((a, b) => a - b)

  const cuts: number[] = []
  for (const cut of candidates) {
    const previous = cuts.at(-1)
    if (previous !== undefined && cut - previous < MIN_CUT_SPACING_TOKENS) {
      // Keep the later one: it saves more reading and costs the same memory.
      cuts[cuts.length - 1] = cut
      continue
    }
    cuts.push(cut)
  }
  return cuts
}
