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

  it('is no longer a carve-out, because the prefix it was cut from is gone', () => {
    // These three were argued for one at a time, as holes in a `settings:` rule
    // that refused the rest. A paired phone is the owner's own phone now, so the
    // rule went and the holes went with it — settings are simply reachable.
    expect(decideRemoteChannel(IpcChannel.Settings.get).allowed).toBe(true)
    expect(decideRemoteChannel(IpcChannel.Settings.update).allowed).toBe(true)
  })

  it('still refuses the two things that are not about trust', () => {
    // This list has shrunk every time a restriction turned out to be an
    // assumption rather than a reason — `memory:list`, then `models:load`, then
    // the rest of them at once. These two are what was left standing: the
    // settings that govern the connection, and the one surface with no
    // confirmation step. See `channelPolicy.test.ts` for why each survives.
    for (const channel of [IpcChannel.Remote.setEnabled, IpcChannel.Terminal.create]) {
      expect(decideRemoteChannel(channel).allowed, channel).toBe(false)
    }
  })

  it('is three channels and not a prefix', () => {
    // `personality:` being allowed by default is only safe while it holds exactly
    // these. One added later — importing one, say, or writing its prompt text —
    // would be reachable from a phone the moment it was declared, without anybody
    // deciding that.
    //
    // `personality:image` was decided: it is a read, of a thumbnail, and it serves
    // only files this app copied into its own picture store (see
    // `personalityPictureAccess.test.ts`), so a hand-edited `image` path cannot turn
    // it into a way to read the disk. Without it the phone drew initials for every
    // personality somebody had given a face.
    expect(Object.values(IpcChannel.Personality)).toEqual([
      'personality:list',
      'personality:set-active',
      'personality:image'
    ])
  })
})
