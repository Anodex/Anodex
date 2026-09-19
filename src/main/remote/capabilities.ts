/**
 * What each end of the bridge can do, beyond what the protocol version guarantees.
 *
 * ## Why this exists rather than a version bump
 *
 * `PROTOCOL_VERSION` is a hard gate: `versionsCompatible()` compares majors at the
 * handshake and refuses the connection outright on a mismatch. That is the right
 * behaviour for a change that breaks the frame format, and exactly the wrong one
 * for a feature that only some builds have — bumping the major to add a feature
 * would refuse every phone in the field, including the ones that do not care about
 * it.
 *
 * So a feature announces itself instead. Both ends list what they can do, neither
 * end uses a feature the other did not claim, and a build that has never heard of
 * a capability simply does not list it. Nothing is refused; the feature is absent.
 *
 * ## Why that matters more here than it would elsewhere
 *
 * The desktop and the phone are two repositories that ship separately, so at any
 * moment a user can be running any pair of versions — including a phone newer than
 * the computer it drives, which is ordinary the day after a phone update. A feature
 * gated on capabilities can therefore be removed from either side alone without
 * breaking the other: the announcement stops, both ends fall back, and nothing on
 * the wire fails. See `docs/HANDOFF_VOICE.md` §9.4, which is where the requirement
 * came from.
 *
 * ## Naming
 *
 * `name.majorVersion` — `voice.1`. A capability whose wire shape changes becomes
 * `voice.2`, which an old peer does not recognise and therefore does not use. This
 * is the same reasoning as the protocol major, scoped to one feature instead of the
 * whole connection.
 */

import { VOICE_CAPABILITY, voiceEnabled } from '../voice/voiceCapability' // voice:seam

/**
 * The most capabilities that will be read from one handshake.
 *
 * A cap because the list arrives from the network before authentication, and an
 * unbounded list of strings is an unbounded allocation triggered by a stranger.
 * Everything past this is dropped rather than refused: a peer that sends a hundred
 * capabilities is more likely confused than hostile, and there is no feature worth
 * failing a handshake over.
 */
const MAX_CAPABILITIES = 32

/** The longest capability name read. Same reasoning as {@link MAX_CAPABILITIES}. */
const MAX_CAPABILITY_LENGTH = 64

/**
 * What this desktop can do, asked fresh at each handshake.
 *
 * A function rather than a constant because the answer can change while the app
 * runs: a feature switched on after launch has to be announced to the next phone
 * that connects, not to the next phone that connects after a restart.
 */
export function desktopCapabilities(): readonly string[] {
  const announced: string[] = []
  // voice:seam — the one line that puts voice on the wire. Removing voice is
  // removing this line; nothing else here knows the feature exists.
  if (voiceEnabled()) announced.push(VOICE_CAPABILITY)
  return announced
}

/**
 * Read a capability list off the wire, never throwing.
 *
 * Deliberately forgiving in one direction only: anything that is not a usable list
 * of names becomes an empty list, and anything unusable *within* a list is dropped
 * while the rest is kept. A malformed capability is a feature that will not be
 * used, which is the safe failure — whereas rejecting the frame would turn a
 * cosmetic disagreement into a phone that cannot connect.
 *
 * Duplicates are collapsed so that a caller counting entries counts features.
 */
export function parseCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    if (entry.length === 0 || entry.length > MAX_CAPABILITY_LENGTH) continue
    seen.add(entry)
    if (seen.size >= MAX_CAPABILITIES) break
  }
  return [...seen]
}

/**
 * Whether a peer announced a capability.
 *
 * Takes `undefined` as "announced nothing" rather than as a mistake, because that
 * is what every peer built before this existed announced — and what a client that
 * is not a phone at all (a renderer window) announces too.
 */
export function hasCapability(
  capabilities: readonly string[] | undefined,
  capability: string
): boolean {
  return capabilities?.includes(capability) ?? false
}
