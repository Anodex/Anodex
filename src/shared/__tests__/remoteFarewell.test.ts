import { describe, expect, it } from 'vitest'
import {
  farewellCode,
  reconnectsImmediately,
  REMOTE_FAREWELL,
  type RemoteFarewell
} from '../remoteFarewell'

/**
 * The reasons the computer gives for going away.
 *
 * These are a wire contract. The phone mirrors this list in Kotlin and matches on
 * the numbers, so a code that changes value here silently becomes a different
 * reason over there — or no reason at all, which is where this started: the bridge
 * called `socket.terminate()`, sending no close frame, and the phone's offline
 * screen had to offer the user three guesses because it had been told nothing.
 */
describe('remote farewell', () => {
  const all = Object.keys(REMOTE_FAREWELL) as RemoteFarewell[]

  it('every code is in the range reserved for applications', () => {
    // 4000-4999 is what the WebSocket spec leaves to applications. Anything below
    // collides with the protocol's own codes, which browsers and libraries may
    // interpret or refuse to send.
    for (const farewell of all) {
      expect(farewellCode(farewell), farewell).toBeGreaterThanOrEqual(4000)
      expect(farewellCode(farewell), farewell).toBeLessThanOrEqual(4999)
    }
  })

  it('no two reasons share a code', () => {
    // The phone matches on the number. Two reasons on one code is one of them
    // silently becoming the other.
    const codes = all.map(farewellCode)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('the codes are pinned, because the phone hardcodes them', () => {
    // Deliberately written out rather than derived. A test that recomputes the
    // values from the object under test would agree with any change, including one
    // that breaks every phone already installed.
    expect(REMOTE_FAREWELL).toEqual({
      quitting: 4001,
      sleeping: 4002,
      disabled: 4003,
      restarting: 4004,
      unpaired: 4005
    })
  })

  it('only a rebind is worth reconnecting straight into', () => {
    // The others need a human: wake the computer, open Anodex, change a setting,
    // pair again. A phone hammering a socket against any of those is spending
    // battery to learn nothing.
    expect(reconnectsImmediately('restarting')).toBe(true)

    for (const farewell of all.filter((name) => name !== 'restarting')) {
      expect(reconnectsImmediately(farewell), farewell).toBe(false)
    }
  })
})
