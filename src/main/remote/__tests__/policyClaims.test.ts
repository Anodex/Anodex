import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decideRemoteChannel } from '../channelPolicy'

/**
 * Comments that state the rule must state the rule that is enforced.
 *
 * `channelPolicy.ts` is the policy. It is also the file nobody reads, because
 * the rule is *explained* in a dozen comments next to the channels it governs —
 * and those are what people act on. On 2026-09-17 three of them were wrong in
 * the same direction: `src/shared/ipc.ts` said twice that "the whole `settings:`
 * prefix is denied to a paired phone", and `memory:` was described the same way
 * in the phone repo.
 *
 * Neither had been true since the policy was narrowed to three refusals. The
 * cost was not confusion: the phone built nine Settings screens around it, two
 * of which tell the owner a setting can only be changed at the computer when it
 * can be changed from their hand. A wrong comment did more damage than a wrong
 * line of code would have, because nothing failed.
 *
 * So: any comment claiming a prefix is denied is checked against the function
 * that decides it. The same shape as every other guard in this repo — one rule,
 * written in two places, and this is the second place being made to agree.
 */

const DENIAL_CLAIM = /`([a-z-]+:)`[^.`]{0,80}?\b(?:is|are|stays?|stay)\s+denied/gi

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sourceFiles(path, found)
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(path)
  }
  return found
}

describe('what the comments say a phone is refused', () => {
  it('matches what the policy actually refuses', () => {
    const wrong: string[] = []

    for (const file of [...sourceFiles('src/shared'), ...sourceFiles('src/main')]) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(DENIAL_CLAIM)) {
        const prefix = match[1]
        // A prefix claimed as denied has to refuse something under it. The
        // sample name cannot collide with a real channel, or a per-channel
        // carve-out would answer for the prefix it was carved out of.
        const decision = decideRemoteChannel(`${prefix}a-channel-that-does-not-exist`)
        if (decision.allowed) {
          const line = text.slice(0, match.index).split('\n').length
          wrong.push(`${file}:${line} claims "${prefix}" is denied, but it is allowed`)
        }
      }
    }

    expect(wrong, wrong.join('\n')).toEqual([])
  })

  it('catches the claim that was actually wrong', () => {
    // The sentence that sent the phone down this road, as a string rather than
    // a memory of it. If the policy is ever widened back to cover `settings:`,
    // this fails and the test above stops being about anything.
    expect(decideRemoteChannel('settings:get').allowed).toBe(true)
    expect(decideRemoteChannel('settings:update').allowed).toBe(true)
    expect(decideRemoteChannel('memory:create').allowed).toBe(true)

    // And the three that are refused, so the regex above has something to find.
    expect(decideRemoteChannel('terminal:anything').allowed).toBe(false)
    expect(decideRemoteChannel('critical-thinking:anything').allowed).toBe(false)
    expect(decideRemoteChannel('remote:set-port').allowed).toBe(false)
  })
})
