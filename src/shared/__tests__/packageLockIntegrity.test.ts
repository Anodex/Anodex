import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The lock file must not list the same package twice.
 *
 * `package-lock.json` is a flat map keyed by install path, and git has no idea it is
 * a map — it is line-oriented, so two branches that each insert a block near the same
 * line merge into two blocks. JSON does not complain about that. The second key simply
 * wins on parse, and the first one is gone.
 *
 * That is how this repo shipped a lock containing
 * `node_modules/mailparser/node_modules/nodemailer` twice — 10.0.1 written by one
 * dependabot bump, 9.0.3 left behind by another. The surviving copy was the stale one,
 * so every `npm ci` on every runner failed with EUSAGE, and `main` stayed red across
 * four merges because the failure reads as an install problem rather than a code one.
 *
 * Nothing else catches it. `npm install` here is happy: it parses the file, silently
 * keeps the last key, and writes back a deduplicated lock — so a developer's working
 * copy self-heals while CI does not. Dependabot has open PRs against this lock now, and
 * they will land the same way.
 */
describe('package-lock.json', () => {
  const lock = readFileSync(resolve(__dirname, '../../../package-lock.json'), 'utf8')

  it('lists every install path exactly once', () => {
    // Read from the text rather than the parsed object: parsing is what loses the
    // evidence. A duplicate key is invisible the instant JSON.parse touches it.
    const seen = new Map<string, number>()
    for (const [, key] of lock.matchAll(/^ {4}"((?:node_modules\/|)[^"]*)": \{$/gm)) {
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }

    const twice = [...seen].filter(([, count]) => count > 1).map(([key]) => key)
    expect(twice).toEqual([])
  })

  it('is reading the keys it thinks it is', () => {
    // Guards the regex, not the lock. If the format shifts and this matches nothing,
    // the test above passes forever while checking nothing at all.
    const keys = [...lock.matchAll(/^ {4}"((?:node_modules\/|)[^"]*)": \{$/gm)]
    expect(keys.length).toBeGreaterThan(500)
    expect(keys.some(([, key]) => key.startsWith('node_modules/'))).toBe(true)
  })
})
