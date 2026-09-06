import { describe, expect, it } from 'vitest'
import { explainUnusableExternalAddress } from '../natpmp'

/**
 * The address the user types after forwarding a port by hand.
 *
 * This is the one field in the feature with no second chance. A wrong *port* costs a
 * failed connection attempt and an obvious retry; a wrong *address* is stored, sent
 * to the phone, and produces a timeout from wherever the user happens to be — the
 * least diagnosable failure this feature has, and the one they cannot debug from a
 * bus.
 *
 * So the rule is: refuse exactly what is provably unusable, and get out of the way
 * for everything else. Whether a port is actually forwarded is between the user and
 * their router and cannot be known from here. Whether 192.168.1.40 is reachable from
 * the internet is arithmetic.
 */
describe('checking a hand-typed public address', () => {
  it('accepts an ordinary public address', () => {
    for (const address of ['203.0.113.7', '8.8.8.8', '100.63.0.1', '172.32.0.1']) {
      expect(explainUnusableExternalAddress(address), address).toBeNull()
    }
  })

  it('accepts an empty field, which means "not set"', () => {
    // Clearing the box is how the user goes back to asking the router, not an error.
    expect(explainUnusableExternalAddress('')).toBeNull()
    expect(explainUnusableExternalAddress('   ')).toBeNull()
  })

  it('refuses a LAN address and says which one they actually need', () => {
    // The most likely mistake by a mile: the address the router shows for *this
    // computer*, rather than the one it shows for itself on the internet side.
    const problem = explainUnusableExternalAddress('192.168.1.40')

    expect(problem).toContain('your own network')
    expect(problem).toContain('WAN')
  })

  it('refuses every private range, not just the familiar one', () => {
    for (const address of ['10.0.0.153', '172.16.0.1', '172.31.255.255', '127.0.0.1']) {
      expect(explainUnusableExternalAddress(address), address).not.toBeNull()
    }
  })

  it('names carrier-grade NAT rather than calling it private', () => {
    // 100.64/10 looks public to anyone reading it and is not. The remedy is
    // completely different — no port forwarding fixes it — so it cannot be folded
    // in with "that's a local address".
    const problem = explainUnusableExternalAddress('100.90.4.7')

    expect(problem).toContain('carrier-grade NAT')
    expect(problem).toContain('sharing one public address')
    expect(problem).not.toContain('your own network')
  })

  it('refuses text that is not an address at all', () => {
    // Pasting the whole line from a router page, or a hostname.
    for (const value of ['my-router.local', 'WAN IP: 203.0.113.7', '203.0.113', '999.1.1.1']) {
      expect(explainUnusableExternalAddress(value), value).not.toBeNull()
    }
  })

  it('ignores surrounding whitespace rather than calling it malformed', () => {
    // Copied out of a router's admin page, which pads its table cells.
    expect(explainUnusableExternalAddress('  203.0.113.7  ')).toBeNull()
  })
})
