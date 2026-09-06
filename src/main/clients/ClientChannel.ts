/**
 * A client the main process can push events to.
 *
 * Anodex has exactly one kind of client today — a renderer window — and the
 * streaming paths reach it through `event.sender`, an Electron `WebContents`.
 * That works precisely as long as every client is a window, which stops being
 * true the moment a paired phone attaches (see `docs/HANDOFF_REMOTE_MOBILE.md`
 * §5.1).
 *
 * This interface is the seam. It is deliberately tiny: send a payload on a
 * channel, and say whether the far end is still there. Anything larger would
 * start to encode assumptions about *how* a client is reached, which is the
 * thing being abstracted away.
 *
 * Worth doing regardless of the phone: it removes the chat pipeline's hard
 * dependency on Electron's window model, which is why the streaming code could
 * only ever talk to the one window that started a generation.
 */
export interface ClientChannel {
  /** Stable identity, for logging and for the remote-client registry. */
  readonly id: string

  /**
   * Best-effort delivery. Never throws.
   *
   * Delivery to a client that has gone away is not an error worth propagating:
   * during a long generation these fire once per token, so a single dead
   * endpoint would otherwise become thousands of unhandled throws.
   */
  send(channel: string, payload: unknown): void

  /** False once the far end is gone. Checked before expensive work, not relied on for safety. */
  isAlive(): boolean
}
