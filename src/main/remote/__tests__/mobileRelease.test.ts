import { describe, expect, it } from 'vitest'
import { EXPECTED_MOBILE_VERSION, isOlderVersion } from '../mobileRelease'

/**
 * Deciding whether the phone is behind the desktop it is paired to.
 *
 * A notice nobody asked for has a low tolerance for being wrong. Telling somebody
 * they are out of date when they are not sends them to reinstall something they
 * already have and teaches them to ignore the banner — after which the one time it
 * is right, it is also useless.
 *
 * So the rule throughout is **fail quiet**: anything unclear compares as not older,
 * and the phone is left alone.
 */
describe('comparing the phone build against the desktop', () => {
  it('spots a phone that is behind', () => {
    expect(isOlderVersion('0.15.0', '0.16.0')).toBe(true)
    expect(isOlderVersion('0.16.0', '0.16.1')).toBe(true)
    expect(isOlderVersion('0.9.0', '0.10.0')).toBe(true)
  })

  it('compares numerically, not as text', () => {
    // The trap in every hand-rolled version compare: "0.9.0" sorts after "0.10.0"
    // as a string, so a phone a whole release behind is told it is current.
    expect(isOlderVersion('0.9.0', '0.10.0')).toBe(true)
    expect(isOlderVersion('0.10.0', '0.9.0')).toBe(false)
    expect(isOlderVersion('1.0.0', '0.99.99')).toBe(false)
  })

  it('says nothing when the two match', () => {
    expect(isOlderVersion('0.16.0', '0.16.0')).toBe(false)
  })

  it('says nothing when the phone is ahead', () => {
    // Normal while a mobile release is being tested before the desktop catches up.
    // Nagging someone to "update" to an older build would be actively wrong.
    expect(isOlderVersion('0.17.0', '0.16.0')).toBe(false)
  })

  it('ignores a preview suffix rather than choking on it', () => {
    // Every release so far is tagged `-preview.N`. Treating that as unparseable
    // would disable the check for the only builds that exist.
    expect(isOlderVersion('0.15.0-preview.19', '0.16.0')).toBe(true)
    expect(isOlderVersion('0.16.0-preview.22', '0.16.0')).toBe(false)
  })

  it('stays quiet on anything it cannot read', () => {
    // An older phone that reports something unexpected, or a field that arrived
    // empty. Guessing here means nagging somebody about a version they may already
    // have — the failure that makes the banner untrustworthy.
    for (const value of ['', 'unknown', '0.16', '0.16.0.1', 'v0.16.0', 'x.y.z']) {
      expect(isOlderVersion(value, '0.16.0'), value).toBe(false)
      expect(isOlderVersion('0.15.0', value), value).toBe(false)
    }
  })

  it('publishes a version the comparison can actually read', () => {
    // The constant is hand-maintained and points at another repository, which is a
    // shape that rots. This at least catches it being set to something malformed,
    // which would silently disable the check everywhere.
    expect(EXPECTED_MOBILE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(isOlderVersion('0.0.1', EXPECTED_MOBILE_VERSION)).toBe(true)
  })
})
