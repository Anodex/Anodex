import { describe, expect, it } from 'vitest'
import { decideRemoteChannel } from '../channelPolicy'

/**
 * The line between choosing a model and acquiring one.
 *
 * A phone may switch between models that are already on the machine, because that
 * is the ordinary thing somebody wants from the sofa and the set was assembled
 * deliberately at the desk. It may not add to that set, search for things to add,
 * or remove anything — those write gigabytes to someone else's disk from a search
 * of the open internet, or destroy a file for good.
 *
 * These pin both halves. The half that is easy to lose is the second: `models:` is
 * denied by prefix, so every carve-out is written by hand, and the temptation when
 * adding the next one is to widen the pattern instead.
 */
describe('switching models from a phone', () => {
  /**
   * This file used to argue a line between *choosing* a model and *acquiring*
   * one: listing and loading were allowed, while downloading, deleting and
   * adding stayed at the machine because they are multi-gigabyte writes to
   * somebody's disk picked from a search of the open internet.
   *
   * That line is gone, and deliberately. A paired phone is the owner's own
   * phone; downloading a model from it is the same act as walking to the desk
   * and doing it. What survives is narrower and is not about trust: the native
   * file picker `models:add` opens cannot be seen or answered from a phone.
   */
  it('can choose, acquire and remove a model', () => {
    for (const channel of [
      'models:list',
      'models:load',
      'models:unload',
      'models:download',
      'models:cancel-download',
      'models:delete',
      'models:discover',
      'models:get-reliability'
    ]) {
      expect(decideRemoteChannel(channel).allowed, channel).toBe(true)
    }
  })

  it('cannot open the file picker that adding one by hand would need', () => {
    // A `dialog.showOpenDialog` on the desk. Downloading a model is the phone's
    // route to the same end and needs no window on a computer nobody is at.
    expect(decideRemoteChannel('models:add').allowed).toBe(false)
    expect(decideRemoteChannel('models:add-vision-projector').allowed).toBe(false)
  })
})
