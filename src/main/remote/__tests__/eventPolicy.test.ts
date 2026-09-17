import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IpcChannel } from '@shared/ipc'
import { decideRemoteChannel, mayPushToRemote } from '../channelPolicy'

/**
 * What the computer sends a phone without being asked.
 *
 * `decideRemoteChannel` guards what a phone may *ask for*, and a test pins that
 * set against the generated protocol. Nothing guarded the other direction:
 * `broadcastToWindows` fanned every event out to every attached client, so the
 * policy was a gate on one side of a two-way socket.
 *
 * The rule here is not "phones get less". The phone is trusted and everything it
 * *does* is a request, so nothing it can do changes. The rule is that the
 * computer should not spend a phone's connection on frames the phone drops, and
 * should not undo a refusal by pushing what it declined to hand over.
 */
describe('what reaches a phone unasked', () => {
  it('sends the ordinary run of events', () => {
    // The default is open, and stays open. This is the assertion that fails if
    // somebody decides the outbound side should be a list of permitted channels.
    for (const channel of [
      IpcChannel.Chat.stream,
      IpcChannel.Conversations.changed,
      IpcChannel.Models.stateChanged,
      IpcChannel.Projects.changed,
      IpcChannel.Diagnostics.entry,
      IpcChannel.Agent.runsChanged
    ]) {
      expect(mayPushToRemote(channel), channel).toBe(true)
    }
  })

  it('does not stream critical thinking to a phone that has no screen for it', () => {
    // The owner's decision: critical thinking stays on the computer. The phone
    // has no code for it at all — not a viewer, not a type — and every token was
    // being sent anyway, through the unmetered broadcast, one frame each.
    expect(mayPushToRemote(IpcChannel.CriticalThinking.stream)).toBe(false)
    expect(mayPushToRemote(IpcChannel.CriticalThinking.runsChanged)).toBe(false)
  })

  it('does not push terminal output, having refused the terminal', () => {
    // A refusal that can be walked around from the other direction is not a
    // refusal. Nothing broadcasts terminal output today — but that is a fact
    // about who holds the session, not a rule, and a rule is what this is.
    expect(mayPushToRemote('terminal:data')).toBe(false)
    expect(decideRemoteChannel('terminal:create').allowed).toBe(false)
  })

  it('leaves the connection prefix open outbound, though it is closed inbound', () => {
    // The distinction that makes this a separate function rather than one shared
    // list. `remote:` requests are refused because a phone rewriting its own
    // connection is how it locks itself out of the computer it is talking to.
    // Being *told* about that connection is the opposite — it is how a phone
    // shows whether it is online — so the prefix is not carried across.
    //
    // No `remote:` event exists today; `remote:status` is a request. That is
    // exactly why this is pinned as a rule rather than as a delivered event: the
    // tempting edit is to share one list between the two functions, and it would
    // pass every other test in this file.
    expect(decideRemoteChannel(IpcChannel.Remote.setPort).allowed).toBe(false)
    expect(mayPushToRemote('remote:status')).toBe(true)
  })

  it('reads the prefix, not an exact name', () => {
    // A channel added under a denied prefix later is covered without anybody
    // remembering to add it here — which is the failure the inbound list had
    // before its own test existed.
    expect(mayPushToRemote('critical-thinking:something-added-later')).toBe(false)
    expect(mayPushToRemote('terminal:something-added-later')).toBe(false)
  })

  it('is enforced where the frame is written, not at each caller', () => {
    // The assertion that keeps this from drifting back. The policy first lived
    // at the three fan-out helpers in `broadcast.ts`, which missed four direct
    // `client.send` calls in handlers and notifications. It now lives on the
    // ClientChannel the bridge hands out, so every path goes through it — and
    // this reads the source to say so, because a runtime test cannot see a door
    // nobody walked through yet.
    const bridge = readFileSync(resolve(__dirname, '..', 'RemoteBridge.ts'), 'utf8')
    expect(bridge).toContain('if (!mayPushToRemote(channel)) return')

    const broadcast = readFileSync(resolve(__dirname, '..', '..', 'broadcast.ts'), 'utf8')
    // One mention only, and it is the one that shapes `reachedEveryone` rather
    // than a second copy of the gate.
    expect(broadcast.match(/mayPushToRemote\(/g)?.length).toBe(1)
  })
})
