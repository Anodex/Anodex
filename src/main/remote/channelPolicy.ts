/**
 * Which channels a paired phone may reach.
 *
 * A denylist rather than an allowlist, and that is a deliberate and uncomfortable
 * choice, so it is worth stating the reasoning.
 *
 * An allowlist fails safe: a channel added later is unreachable until someone
 * lists it. A denylist fails open. The reason this is a denylist anyway is that
 * the product goal is *parity* — the phone is meant to reach Chat, Agent,
 * Workspace, Email and Critical Thinking as the desktop has them, which is
 * almost all 201 channels. An allowlist of ~190 entries would be copied from the
 * channel list once and then rot, and a rotting allowlist silently removes
 * features rather than silently adding them, which is the failure nobody
 * notices until a user reports it.
 *
 * The mitigation for choosing the riskier default is that **the deny rules below
 * are enforced by a test that reads the generated protocol artifact**, so a new
 * channel matching a dangerous prefix fails the build rather than quietly
 * becoming remotely reachable.
 */

/**
 * Channels no remote client may invoke, whatever it claims to be.
 *
 * Each is here for a specific reason, not by category.
 */
export const DENIED_CHANNEL_PREFIXES = [
  /**
   * A software keyboard against a shell that is not a real PTY. `TerminalService`
   * is `child_process.spawn` and its `resize()` is a no-op, so the experience
   * would be poor — but the reason it is *denied* rather than deprioritised is
   * that a terminal is arbitrary command execution with no confirmation step.
   */
  'terminal:',

  /**
   * Driving the host's mouse and keyboard from a phone. There is no version of
   * this that is not a way to do anything at all on the machine.
   */
  'computer-control:',

  /**
   * Configuration surfaces. Each widens the blast radius and none benefits from
   * being remote: a phone that can rewrite settings can turn off the very
   * protections that let it connect.
   */
  'settings:',
  'mcp:',
  'memory:',

  /**
   * Loading a 30B model is done at the machine, deliberately.
   *
   * Note the exception in ALLOWED_CHANNELS: `models:get-state` is a read, and it
   * is what tells the phone which model is loaded and how full its context is.
   * Blocking the whole prefix left the connection header permanently blank.
   */
  'models:',

  /**
   * Remote access administers itself only from the machine.
   *
   * A phone that could turn the listener off, unpair itself, or mint a fresh
   * pairing code would be able to rewrite the conditions under which it is
   * allowed to talk at all — including handing a new device key to whoever asked.
   */
  'remote:'
] as const

/**
 * Specific channels denied where the whole group is not.
 *
 * These open a native dialog on the *host* — a file picker, a save sheet — which
 * from a phone means a window appearing on a computer in another room, in front
 * of nobody, blocking whatever asked for it.
 */
export const DENIED_CHANNELS = [
  'attachments:pick-files',
  'attachments:pick-directory',
  'workspace:pick-directory',
  'project:pick-directory',
  'backup:pick-file',
  'backup:pick-directory',
  'critical-thinking:export-pdf',
  'diagnostics:reveal-log'
] as const

/**
 * Channels allowed despite matching a denied prefix.
 *
 * Checked before the prefixes, so a narrow read can be carved out of a group that
 * is otherwise off-limits. Kept tiny on purpose: every entry is a hole in a rule
 * that exists for a reason, so each one is listed individually rather than by
 * pattern.
 */
export const ALLOWED_CHANNELS = [
  /** Read-only. Feeds the phone's connection header — which model, how full (§8). */
  'models:get-state',
  'models:state-changed'
] as const

export type RemoteChannelDecision =
  { allowed: true } | { allowed: false; reason: string; message: string }

/**
 * Decide whether a remote client may invoke a channel.
 *
 * A refusal is always explicit and named. Failing silently would leave the phone
 * waiting on a reply that never comes, and the user with an app that appears to
 * hang for no reason — see §6, "explicit, named refusal for desktop-only
 * channels".
 */
export function decideRemoteChannel(channel: string): RemoteChannelDecision {
  if ((ALLOWED_CHANNELS as readonly string[]).includes(channel)) {
    return { allowed: true }
  }

  if ((DENIED_CHANNELS as readonly string[]).includes(channel)) {
    return {
      allowed: false,
      reason: 'desktop-only',
      message: `"${channel}" opens a window on the computer, so it only works there.`
    }
  }

  const prefix = DENIED_CHANNEL_PREFIXES.find((p) => channel.startsWith(p))
  if (prefix) {
    return {
      allowed: false,
      reason: 'desktop-only',
      message: `"${channel}" is only available at the computer.`
    }
  }

  return { allowed: true }
}
