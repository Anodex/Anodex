import { describe, expect, it } from 'vitest'
import { decideRemoteChannel } from '../channelPolicy'

/**
 * What a paired phone may reach.
 *
 * The owner's decision, stated plainly: **a paired phone is the user's own
 * trusted phone, and may see and do what they can do at the machine.** Pairing
 * is the trust boundary, and it is a strong one — a pinned certificate, a
 * 40-bit code that lives two minutes, five guesses before a lockout, and a
 * 256-bit device key the computer only ever stores a hash of.
 *
 * These tests used to assert the opposite, group by group, each with its own
 * reasoning about what a phone should not be trusted with. That argument is
 * gone. What is left is narrow and is not about trust, so this file pins the
 * *reasons* rather than a list: the tempting future edit is to widen one of the
 * two remaining refusals because it looks arbitrary beside everything allowed.
 */
describe('remote channel policy', () => {
  it('lets a trusted phone do what the person holding it could do at the desk', () => {
    // Every one of these was refused before, each on its own written-down
    // reasoning about what a phone should not be trusted with.
    for (const channel of [
      'settings:get',
      'settings:update',
      'mcp:add',
      'mcp:remove',
      'memory:create',
      'memory:update',
      'models:download',
      'models:delete',
      'models:unload',
      'computer-control:start',
      'checkpoints:restore',
      'checkpoints:undo',
      'checkpoints:rollback',
      'workspace:delete-path'
    ]) {
      expect(decideRemoteChannel(channel).allowed, channel).toBe(true)
    }
  })

  it('still refuses the settings that govern the connection itself', () => {
    // Not because a phone might abuse them. Because changing the port, the
    // address or the listener from the device that depends on them is how a
    // phone locks itself out of the computer it is talking to, and the way back
    // is a walk to the desk.
    for (const channel of [
      'remote:set-enabled',
      'remote:set-port',
      'remote:set-manual-address',
      'remote:set-internet-access',
      'remote:begin-pairing',
      'remote:revoke'
    ]) {
      expect(decideRemoteChannel(channel).allowed, channel).toBe(false)
    }
  })

  it('still refuses the terminal, the one surface with nothing to confirm', () => {
    // `run_command` is reachable and goes through the approval flow, so a phone
    // can already have the computer run things — with a yes in between. A raw
    // terminal stream has no such step.
    for (const channel of ['terminal:create', 'terminal:write', 'terminal:kill']) {
      expect(decideRemoteChannel(channel).allowed, channel).toBe(false)
    }
  })

  it('still refuses what would only put a window on an empty desk', () => {
    // Not a permission decision, and not permanent: each becomes an ordinary
    // feature the moment it is made to work on the phone's own screen. A picker
    // or a save sheet opening on a computer in another room blocks whatever
    // asked for it, in front of nobody, with the phone showing no sign of it.
    for (const channel of [
      'attachments:pick-files',
      'critical-thinking:export-pdf',
      'diagnostics:save-support-bundle',
      'workspace:open-path',
      'workspace:reveal-in-explorer',
      'projects:open-folder',
      'projects:open-in-browser',
      'email:open-webmail',
      'models:add',
      'models:add-vision-projector',
      'settings:pick-personality-image',
      'settings:open-models-dir'
    ]) {
      expect(decideRemoteChannel(channel).allowed, channel).toBe(false)
    }
  })

  it('refuses the picker without refusing the thing the picker was for', () => {
    // The distinction the list above turns on, asserted separately because it is
    // the one that gets lost. Choosing and loading a model is ordinary; only the
    // native dialog that would open on the desk to pick a file is not.
    expect(decideRemoteChannel('models:add').allowed).toBe(false)
    expect(decideRemoteChannel('models:list').allowed).toBe(true)
    expect(decideRemoteChannel('models:load').allowed).toBe(true)

    expect(decideRemoteChannel('settings:pick-personality-image').allowed).toBe(false)
    expect(decideRemoteChannel('settings:forget-personality-image').allowed).toBe(true)
  })

  it('names every refusal', () => {
    // A silent refusal leaves the phone waiting on a reply that is not coming,
    // and the user with an app that appears to hang for no reason.
    const decision = decideRemoteChannel('terminal:write')
    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.reason).toBe('desktop-only')
    expect(decision.message).toContain('terminal:write')
  })

  it('allows an ordinary channel nobody ever had to argue for', () => {
    expect(decideRemoteChannel('chat:send').allowed).toBe(true)
    expect(decideRemoteChannel('conversations:list').allowed).toBe(true)
  })
})
