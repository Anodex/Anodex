import { describe, expect, it } from 'vitest'

/**
 * How much of its own history a continuing run is told about.
 *
 * The journal file is append-only and never trimmed, which is right for a
 * record somebody may need to audit — and wrong for a prompt. The whole of it
 * goes into the first turn of every continuing run, so a series that has run
 * thirty times would open its thirty-first with thousands of tokens of its own
 * past before the goal is even stated, on an engine whose window may be 8k.
 *
 * These cases are about the two ways that bound can go wrong: cutting so
 * aggressively that the run cannot continue anything, and cutting silently.
 */
import { JOURNAL_PROMPT_BUDGET, buildKickoffPrompt, journalForPrompt } from '../agentPrompts'

/** A journal of `count` entries, each recognisably its own. */
function journalOf(count: number, bodyLength = 200): string {
  const entries = []
  for (let index = 1; index <= count; index++) {
    entries.push(
      `## 2026-09-${String(index).padStart(2, '0')} 10:00 — done\n\n` +
        `- Goal: keep the thing up to date\n- Turns used: 4\n\n` +
        `Run ${index}: ${'x'.repeat(bodyLength)}\n`
    )
  }
  return entries.join('\n')
}

describe('the journal a continuing run is shown', () => {
  it('is the whole thing while it is short enough to be', () => {
    const journal = journalOf(3)
    expect(journal.length).toBeLessThan(JOURNAL_PROMPT_BUDGET)
    expect(journalForPrompt(journal)).toBe(journal.trim())
  })

  it('keeps the most recent runs when there are too many', () => {
    // Recent rather than a summary: the last thing that happened is what a
    // continuing run continues from, and summarising would mean a model
    // rewriting the record of what a model did.
    const digest = journalForPrompt(journalOf(40))!

    expect(digest.length).toBeLessThan(journalOf(40).length)
    expect(digest).toContain('Run 40:')
    expect(digest).not.toContain('Run 1:')
  })

  it('says how many runs it is not showing', () => {
    // A run told "you have worked on this before" and shown three entries
    // would otherwise conclude three is all there was. An agent that thinks
    // it is on run 3 of an ongoing job behaves differently from one that
    // knows it is on run 31.
    const digest = journalForPrompt(journalOf(40))!
    expect(digest).toMatch(/\d+ earlier runs of this work are not shown/)
  })

  it('never cuts an entry in half', () => {
    // Half an entry is worse than none: its status line and its summary can
    // land on opposite sides of the cut, leaving a failure that reads as a
    // success.
    const digest = journalForPrompt(journalOf(40))!
    const headings = digest.match(/^## /gm) ?? []
    const bodies = digest.match(/^Run \d+:/gm) ?? []
    expect(headings).toHaveLength(bodies.length)
  })

  it('still shows the latest run when that one entry is itself too long', () => {
    // A run whose summary ran very long. Returning nothing would leave a
    // continuing run with no idea what it was continuing.
    const digest = journalForPrompt(journalOf(1, JOURNAL_PROMPT_BUDGET * 2))!
    expect(digest).toContain('Run 1:')
    expect(digest).toContain('entry truncated')
    expect(digest.length).toBeLessThan(JOURNAL_PROMPT_BUDGET * 1.2)
  })

  it('is null for a series that has written nothing', () => {
    expect(journalForPrompt(null)).toBeNull()
    expect(journalForPrompt('   \n  ')).toBeNull()
  })

  it('takes the budget as an argument, so the bound is testable at all', () => {
    const digest = journalForPrompt(journalOf(10), 600)!
    expect(digest).toContain('Run 10:')
    expect(digest).not.toContain('Run 5:')
  })

  it('is applied by buildKickoffPrompt itself, not by whoever calls it', () => {
    // The bound lives inside the prompt builder rather than at the one call
    // site in `AgentRunService`, so a second caller — a scheduled
    // continuation, a retry — cannot reintroduce the unbounded prompt by
    // simply not knowing about it. This is the assertion that would fail if
    // somebody moved it back out.
    const prompt = buildKickoffPrompt('Keep the thing up to date', journalOf(40))
    expect(prompt).toContain('--- JOURNAL ---')
    expect(prompt).toContain('Run 40:')
    expect(prompt).not.toContain('Run 1:')
    expect(prompt).toMatch(/earlier runs of this work are not shown/)
  })
})
