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

  it('still refuses the models: channels that do something', () => {
    for (const channel of ['models:load', 'models:delete', 'models:download', 'models:add']) {
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
