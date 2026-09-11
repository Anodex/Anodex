/**
 * Why the computer went away, said before it does.
 *
 * A phone that loses its socket learns nothing from the socket itself. Asleep,
 * quit, remote access switched off, Wi-Fi gone, laptop carried out of range — all
 * of them arrive as the same dead connection, so the phone has to offer the user a
 * list of guesses. Its offline screen says, verbatim:
 *
 * > No answer from 3 addresses on port 47800. Check the computer is awake, that
 * > remote access is on in its Settings, and that Windows Firewall is not blocking
 * > Anodex.
 *
 * Three hypotheses, because it genuinely cannot tell. In every case below the
 * computer knew perfectly well which one it was and simply did not say — it called
 * `socket.terminate()`, which drops the TCP connection with no close frame at all.
 *
 * So these are sent as the WebSocket close code and reason on the way out. The
 * phone turns them into a fact: "Gort went to sleep" instead of a checklist.
 *
 * The codes are in the 4000-4999 range the WebSocket spec reserves for
 * applications. They are a wire contract shared with the phone, which mirrors this
 * list — `RemoteFarewellTest` over there pins the two together, the same way
 * `versionsCompatible` is pinned.
 */
export const REMOTE_FAREWELL = {
  /** Anodex is closing. Nothing is wrong; it will be back when it is opened. */
  quitting: 4001,
  /** The computer is suspending. Waking it is the whole fix. */
  sleeping: 4002,
  /** Remote access was switched off at the machine, deliberately. */
  disabled: 4003,
  /**
   * The listener is being rebound, usually onto a different port.
   *
   * Distinct from the rest because the phone should reconnect immediately rather
   * than settle into an offline screen — the computer is not going anywhere.
   */
  restarting: 4004,
  /** This device was unpaired at the machine. Reconnecting will not help. */
  unpaired: 4005
} as const

export type RemoteFarewell = keyof typeof REMOTE_FAREWELL

/** The close code for a farewell, for the socket to carry. */
export function farewellCode(farewell: RemoteFarewell): number {
  return REMOTE_FAREWELL[farewell]
}

/**
 * Whether a farewell means "try again shortly" rather than "wait for a human".
 *
 * Only a rebind does. Everything else needs the computer woken, Anodex opened, a
 * setting changed, or a pairing redone — and a phone retrying hard against any of
 * those is a phone burning battery to learn nothing.
 */
export function reconnectsImmediately(farewell: RemoteFarewell): boolean {
  return farewell === 'restarting'
}
