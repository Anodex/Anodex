import { describe, expect, it } from 'vitest'
import { IpcChannel } from '@shared/ipc'
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
  it('may see what is installed and load one of them', () => {
    expect(decideRemoteChannel(IpcChannel.Models.list).allowed).toBe(true)
    expect(decideRemoteChannel(IpcChannel.Models.load).allowed).toBe(true)
  })

  it('still reads engine state, which the header depends on', () => {
    expect(decideRemoteChannel(IpcChannel.Models.getState).allowed).toBe(true)
    expect(decideRemoteChannel(IpcChannel.Models.stateChanged).allowed).toBe(true)
  })

  it('may not acquire a model', () => {
    for (const channel of [
      IpcChannel.Models.add,
      IpcChannel.Models.addVisionProjector,
      IpcChannel.Models.download,
      IpcChannel.Models.discover,
      IpcChannel.Models.fetchTopModels
    ]) {
      expect(decideRemoteChannel(channel).allowed, channel).toBe(false)
    }
  })

  it('may not delete one', () => {
    // Irreversible, and off a device that cannot see how large the file was or
    // what else was relying on it.
    expect(decideRemoteChannel(IpcChannel.Models.delete).allowed).toBe(false)
  })

  it('may not unload, because nothing is gained by allowing it', () => {
    // Loading a different model covers every reason to want this, and an unload
    // leaves the desk with an assistant that cannot answer at all.
    expect(decideRemoteChannel(IpcChannel.Models.unload).allowed).toBe(false)
  })

  it('has not quietly become the whole prefix', () => {
    // The failure this exists to catch: someone allowing `models:` outright, or
    // adding a pattern rule, the next time one more channel is needed.
    for (const channel of [
      IpcChannel.Models.getReliability,
      IpcChannel.Models.recommendSettings,
      IpcChannel.Models.cancelDownload,
      IpcChannel.Models.getLoadRecovery,
      IpcChannel.Models.dismissLoadRecovery
    ]) {
      expect(decideRemoteChannel(channel).allowed, channel).toBe(false)
    }
  })
})
