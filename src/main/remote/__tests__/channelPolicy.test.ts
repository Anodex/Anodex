import { describe, expect, it } from 'vitest'
import { decideRemoteChannel } from '../channelPolicy'

/**
 * What a paired phone may reach.
 *
 * The policy is a denylist, which fails open, so these tests are the mitigation:
 * a channel that must never be remote is asserted here rather than trusted to a
 * prefix somebody remembered to add.
 */
describe('remote channel policy', () => {
  it('refuses the channels that would be remote code execution', () => {
    for (const channel of [
      'terminal:write',
      'terminal:create',
      'computer-control:start',
      'computer-control:list-desktop-targets'
    ]) {
      expect(decideRemoteChannel(channel).allowed).toBe(false)
    }
  })

  it('refuses configuration surfaces', () => {
    // A phone that can rewrite settings can turn off the protections that let it
    // connect at all.
    for (const channel of ['settings:update', 'mcp:add', 'memory:save', 'remote:set-enabled']) {
      expect(decideRemoteChannel(channel).allowed).toBe(false)
    }
  })

  it('refuses handlers that would open a dialog on the host', () => {
    // A window appearing on a computer in another room, in front of nobody,
    // blocking whatever asked for it.
    for (const channel of ['attachments:pick-files', 'critical-thinking:export-pdf']) {
      expect(decideRemoteChannel(channel).allowed).toBe(false)
    }
  })

  it('allows reading the model state despite the models: prefix', () => {
    // The carve-out exists because the whole prefix left the phone's connection
    // header permanently blank — it is a read, and §8 lists it as allowed.
    expect(decideRemoteChannel('models:get-state').allowed).toBe(true)
    expect(decideRemoteChannel('models:state-changed').allowed).toBe(true)
  })

  it('still refuses the models: channels that acquire or destroy', () => {
    // `models:load` used to be in this list. Switching between models already on
    // the machine was allowed deliberately — see `modelSwitching.test.ts`, which
    // draws the line and pins both sides of it. What stayed refused is anything
    // that writes gigabytes to someone else's disk or removes a file for good.
    for (const channel of ['models:delete', 'models:download', 'models:add']) {
      expect(decideRemoteChannel(channel).allowed).toBe(false)
    }
  })

  it('allows the surfaces the phone exists for', () => {
    for (const channel of [
      'chat:send',
      'chat:stop',
      'tools:confirm-response',
      'conversation:list',
      'agent:list',
      'workspace:read-file',
      'email:list'
    ]) {
      expect(decideRemoteChannel(channel).allowed).toBe(true)
    }
  })

  it('names every refusal', () => {
    // A silent refusal leaves the phone waiting on a reply that is not coming.
    const decision = decideRemoteChannel('terminal:write')
    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.reason).toBe('desktop-only')
    expect(decision.message).toContain('terminal:write')
  })
})

/**
 * The memory carve-out, pinned in both directions.
 *
 * Written because the useful half of this is what it still refuses. A future
 * change that widens `memory:` to the whole prefix would look reasonable in a
 * diff — two channels are already allowed — and would quietly hand a phone the
 * ability to write memories, which are injected into every later prompt.
 */
describe('memory from a phone', () => {
  it('can read what is remembered and forget one line', () => {
    expect(decideRemoteChannel('memory:list').allowed).toBe(true)
    expect(decideRemoteChannel('memory:delete').allowed).toBe(true)
  })

  it('cannot write one', () => {
    // Forgetting only narrows what the model is told. Adding steers every later
    // conversation, from a device that might be in somebody else's hand.
    expect(decideRemoteChannel('memory:create').allowed).toBe(false)
    expect(decideRemoteChannel('memory:update').allowed).toBe(false)
  })
})
