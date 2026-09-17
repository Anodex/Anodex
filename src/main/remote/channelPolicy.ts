/**
 * Which channels a paired phone may reach.
 *
 * **A paired phone is the user's own trusted phone, and may see and do what they
 * can do at the machine.** That is the owner's decision, stated plainly, and it
 * is what this file now encodes. Pairing is the trust boundary; what happens
 * after it is not re-litigated channel by channel.
 *
 * Two things stay refused, each for a reason that is not about trust:
 *
 * - `remote:` — the settings that govern the connection itself. Not withheld
 *   because a phone might abuse them, but because changing the port, the manual
 *   address or the listener from the device that depends on them is how a phone
 *   locks itself out of the computer it is talking to. The one place where
 *   letting someone do a thing is how they lose the ability to do anything.
 * - `terminal:` — a raw stream with no confirmation step. Everything else a
 *   phone can ask for goes through the approval flow, including `run_command`;
 *   the terminal is the one surface that would bypass it.
 *
 * Beyond those, the list below holds only actions that do nothing useful from a
 * phone: a native file picker or save sheet, a folder opening in Explorer, a
 * browser window — all of them appearing on a computer in another room, in front
 * of nobody, with the phone showing no sign it happened. Those are not
 * permission decisions and they are not permanent; each becomes an ordinary
 * feature the moment it is made to work on the phone's own screen.
 *
 * The reachable set is pinned by a test that reads the generated protocol
 * artifact — see `remoteReach.test.ts`. A channel added later is compared
 * against that list, so making one reachable stays a deliberate edit.
 */

/**
 * Channels no remote client may invoke, whatever it claims to be.
 *
 * Each is here for a specific reason, not by category.
 */
export const DENIED_CHANNEL_PREFIXES = [
  /**
   * Driving the mouse and keyboard is allowed; rewriting the connection is not.
   *
   * A phone that changes the port, the manual address, or turns the listener
   * off is changing the conditions under which it is able to speak at all, from
   * the far end of them. The failure is not misuse, it is a locked door with
   * the key on the inside — and the way back is walking to the computer.
   */
  'remote:',

  /**
   * A raw stream with no confirmation step.
   *
   * Every other thing a phone can ask for passes through the approval flow,
   * `run_command` included — so a phone can already have the computer run
   * things, with a yes in between. A terminal has no such step, which makes it
   * the one surface where "trusted device" and "nothing to confirm" stack up.
   */
  'terminal:'
] as const

/**
 * Specific channels denied where the whole group is not.
 *
 * Three kinds of thing, all of which assume somebody is sitting at the machine.
 *
 * The first opens a native dialog on the *host* — a file picker, a save sheet —
 * which from a phone means a window appearing on a computer in another room, in
 * front of nobody, blocking whatever asked for it.
 *
 * The second opens a window or hands a file to another program. `workspace:open-path`
 * is the sharp one: it is `shell.openPath`, which launches a file in whatever
 * application the OS associates with it. Bounded to the workspace, but a workspace
 * containing a `.bat` or a `.lnk` makes that arbitrary execution triggered from a
 * phone, and nothing about it is visible to the person holding the phone.
 *
 * Deleting a file used to be a third category here, refused because it is
 * irreversible. It is allowed now, on the owner's decision, and the guard moved
 * to where it belongs: the phone asks before it deletes. A confirmation the
 * person can read beats a refusal they cannot override.
 */
export const DENIED_CHANNELS = [
  'attachments:pick-files',
  'attachments:pick-directory',
  'workspace:pick-directory',
  'project:pick-directory',
  'backup:pick-file',
  'backup:pick-directory',
  'critical-thinking:export-pdf',
  'diagnostics:reveal-log',

  // Runs a program on the host, chosen by file association.
  'workspace:open-path',

  // Opens a window on a screen nobody is looking at.
  'workspace:reveal-in-explorer',

  /**
   * The same three acts as the entries around them, reached by another name.
   *
   * `projects:open-folder` is `shell.openPath` — the identical call that
   * `workspace:open-path` two lines up is denied for, on a folder rather than a
   * file. The other two are `shell.openExternal`, which hands a URL to the
   * host's browser. All three were reachable from a phone while the channels
   * they are indistinguishable from were not, which is the whole of the reason
   * they are here: the rule was already decided, it just had not been applied
   * to every channel that performs it.
   */
  'projects:open-folder',
  'projects:open-in-browser',
  'email:open-webmail',

  /**
   * A native save sheet on the host. The first category above, and
   * `diagnostics:reveal-log` — its sibling, one handler over — was already here.
   */
  'diagnostics:save-support-bundle',

  /**
   * Invokes a callback registered by a right-click menu on the desktop. There is
   * no menu open on a computer nobody is at, so from a phone this can only ever
   * fire a stale action or nothing.
   */
  'context-menu:run-action',
  'workspace:open-html-preview-window',
  'workspace:refresh-html-preview-window',

  /**
   * Native pickers and folder windows the removed prefixes used to cover.
   *
   * `models:add` and `models:add-vision-projector` are `dialog.showOpenDialog`;
   * `settings:pick-personality-image` is the same; `settings:open-models-dir` is
   * `shell.openPath`. Choosing a model is allowed — this is only the file picker
   * that would open on the desk to do it, which the phone cannot see or answer.
   */
  'models:add',
  'models:add-vision-projector',
  'settings:pick-personality-image',
  'settings:open-models-dir'
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
  // Empty, and that is the point: every entry here was a hole cut in a prefix
  // rule that no longer exists. `models:get-state`, `settings:get-profile`,
  // `memory:list` and the rest are reachable now because their whole subsystems
  // are, not because each was argued for one at a time.
] as const

/**
 * Event channels a paired phone is not sent.
 *
 * `decideRemoteChannel` guards what a phone may *ask for*. Nothing guarded what
 * the computer *sends back on its own* — `broadcastToWindows` fanned every event
 * out to every attached client, phone included, and the two halves of the same
 * rule did not agree.
 *
 * This is not a second opinion about trust. The phone is trusted and nothing it
 * can do changes here, because everything it does is a request. This is about the
 * two cases where sending anyway is either dishonest or simply wasteful.
 *
 * `remote:` is deliberately **not** on this list, and the difference is the whole
 * point of having two functions rather than one shared list. A phone is refused
 * the ability to *change* the connection it depends on; being *told* about that
 * connection is how it shows you whether it is online. Blocking the events
 * because the requests are blocked would be pattern-matching on a prefix instead
 * of reading the reason under it.
 */
export const DENIED_EVENT_PREFIXES = [
  /**
   * The refusal on the request side is only half a refusal if the output arrives
   * anyway.
   *
   * `terminal:` is closed to a phone because a raw stream has no confirmation
   * step. A phone cannot open a session, so today nothing addresses terminal
   * output to one — but that is an accident of who holds the session, not a rule,
   * and the day something broadcasts terminal output the block becomes decorative
   * without anybody editing it.
   */
  'terminal:',

  /**
   * A feature the phone does not have, streaming token by token to a phone that
   * drops every frame.
   *
   * Critical thinking stays on the computer — the owner's decision, and the phone
   * has no code for it at all. Meanwhile `CriticalThinkingService` announces every
   * token through the unmetered broadcast, so a run spends somebody's mobile data
   * on a screen that does not exist. `broadcastLiveToken` was written for exactly
   * this cost and this path never used it.
   *
   * If the phone ever grows a critical-thinking screen, this line comes out — and
   * the send should move to `broadcastLiveToken` at the same time, so it is a
   * choice rather than a firehose.
   */
  'critical-thinking:'
] as const

/**
 * Whether an event may be sent to a paired phone.
 *
 * Deliberately a plain boolean rather than [RemoteChannelDecision]. A refused
 * *request* must be named, because the phone is waiting on a reply and silence
 * reads as a hang. A refused *event* has nobody waiting: not sending it is the
 * whole action, and inventing a failure frame to describe it would put something
 * on the wire that the block exists to keep off.
 */
export function mayPushToRemote(channel: string): boolean {
  return !DENIED_EVENT_PREFIXES.some((prefix) => channel.startsWith(prefix))
}

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
