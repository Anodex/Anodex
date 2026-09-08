import { describe, expect, it } from 'vitest'
import { IpcChannel } from '@shared/ipc'
import { decideRemoteChannel } from '../channelPolicy'

/**
 * The size of the door the personality picker opens.
 *
 * A phone cannot reach `settings:` — deliberately, because that prefix carries the
 * permission mode, the MCP servers and the model directory, and a client that can
 * write to it can dismantle the protections that let it connect in the first place.
 *
 * Choosing a personality is not that. It changes the wording of a system prompt and
 * nothing else, so it got two channels of its own rather than a hole in the wall.
 * The whole value of doing it that way is that the wall is still there, which is
 * what these check — the carve-out, and everything it must not have brought with it.
 */
describe('the personality channels', () => {
  it('lets a phone read and change the personality', () => {
    expect(decideRemoteChannel(IpcChannel.Personality.list).allowed).toBe(true)
    expect(decideRemoteChannel(IpcChannel.Personality.setActive).allowed).toBe(true)
  })

  it('still refuses the settings prefix it was carved out of', () => {
    // The failure this exists to catch: someone reaching for `settings:update`
    // later because it is "the same kind of thing", or lifting the deny rule to
    // make some other setting reachable.
    expect(decideRemoteChannel(IpcChannel.Settings.get).allowed).toBe(false)
    expect(decideRemoteChannel(IpcChannel.Settings.update).allowed).toBe(false)
  })

  it('still refuses everything the phone was never meant to touch', () => {
    for (const channel of [
      IpcChannel.Mcp.add,
      // Was `memory:list` until reading memory from a phone was allowed
      // deliberately — see `channelPolicy.test.ts`, which draws that line and pins
      // both halves of it. Create is the one that stayed refused: a memory is fed
      // into later prompts, so writing one steers every conversation after it.
      IpcChannel.Memory.create,
      IpcChannel.Remote.setEnabled,
      IpcChannel.Terminal.create,
      // Was `models:load` until switching models from a phone was allowed
      // deliberately — see `modelSwitching.test.ts`, which draws that line. Delete
      // is the one that stayed refused: it destroys a file for good.
      IpcChannel.Models.delete
    ]) {
      expect(decideRemoteChannel(channel).allowed, channel).toBe(false)
    }
  })

  it('is two channels and not a prefix', () => {
    // `personality:` being allowed by default is only safe while it holds exactly
    // these two. A third added later — importing one, say, or writing its prompt
    // text — would be reachable from a phone the moment it was declared, without
    // anybody deciding that.
    expect(Object.values(IpcChannel.Personality)).toEqual([
      'personality:list',
      'personality:set-active'
    ])
  })
})
