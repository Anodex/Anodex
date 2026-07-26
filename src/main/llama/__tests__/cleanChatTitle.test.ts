import { describe, expect, it } from 'vitest'
import { cleanChatTitle } from '../LlamaService'

describe('cleanChatTitle', () => {
  it('accepts a well-formed title as-is', () => {
    expect(cleanChatTitle('Fix Sidebar Hover Preview')).toBe('Fix Sidebar Hover Preview')
  })

  it('strips a leading "Title:" prefix', () => {
    expect(cleanChatTitle('Title: Plan Garden Layout')).toBe('Plan Garden Layout')
  })

  it('strips wrapping markdown bold/italic markers', () => {
    // Regression: observed live — the model sometimes wraps its title in
    // markdown emphasis, and the asterisks showed up literally in the
    // sidebar because nothing stripped them.
    expect(cleanChatTitle('**Fetch URL Content**')).toBe('Fetch URL Content')
    expect(cleanChatTitle('__Plan Simple Counter App__')).toBe('Plan Simple Counter App')
    expect(cleanChatTitle('*Check Git Status and Diff*')).toBe('Check Git Status and Diff')
  })

  it('strips wrapping quotes and trailing punctuation', () => {
    expect(cleanChatTitle('"Build Personal Site."')).toBe('Build Personal Site')
  })

  it('rejects a reply that echoes the title-generation instruction instead of following it', () => {
    // Regression: observed live, reproduced twice across separate sessions —
    // the model echoed a paraphrase of its own system instruction back as
    // the "title" instead of generating a real one.
    expect(cleanChatTitle('Goal: Create a 3-6 word Title Case')).toBeNull()
    expect(cleanChatTitle('Sure, here is a concise title for this conversation')).toBeNull()
    expect(cleanChatTitle('I will use Title Case with no preamble')).toBeNull()
  })

  it('returns null for empty or whitespace-only input', () => {
    expect(cleanChatTitle('')).toBeNull()
    expect(cleanChatTitle('   \n  ')).toBeNull()
  })

  it('returns null for a too-short result', () => {
    expect(cleanChatTitle('Hi')).toBeNull()
  })

  it('caps to 7 words and 60 characters', () => {
    const long = 'One Two Three Four Five Six Seven Eight Nine Ten'
    expect(cleanChatTitle(long)).toBe('One Two Three Four Five Six Seven')
  })

  it('uses only the first non-empty line', () => {
    expect(cleanChatTitle('\n\nFix Login Bug\nSome extra text below')).toBe('Fix Login Bug')
  })

  it('discards a reasoning block and titles from the answer after it', () => {
    // A reasoning model puts its scratchpad first; without this the block's
    // opening words became the title.
    expect(
      cleanChatTitle('<think>The user wants a title. Let me think.</think>\nReply To Email')
    ).toBe('Reply To Email')
  })

  it('discards an unterminated reasoning block', () => {
    expect(cleanChatTitle('Summarize Email Thread\n<think>still reasoning here')).toBe(
      'Summarize Email Thread'
    )
  })

  it('skips a narration preamble to reach the real title', () => {
    // Observed directly: a conversation about email got titled
    // "Here's a thinking process".
    expect(cleanChatTitle("Here's a thinking process\n\nSummarize Email Thread")).toBe(
      'Summarize Email Thread'
    )
    expect(cleanChatTitle('Okay, the user wants a title.\nFix Login Bug')).toBe('Fix Login Bug')
    expect(cleanChatTitle('Let me think about this.\nPlan Garden Layout')).toBe(
      'Plan Garden Layout'
    )
  })

  it('keeps titles whose first word merely resembles narration', () => {
    // The preamble list must not eat legitimate titles.
    expect(cleanChatTitle('First Draft Review')).toBe('First Draft Review')
    expect(cleanChatTitle('Plan Garden Layout')).toBe('Plan Garden Layout')
    expect(cleanChatTitle('Sure Thing Bakery Website')).toBe('Sure Thing Bakery Website')
  })

  it('falls back to the only line when every line looks like narration', () => {
    // Better a mediocre title than none; the caller treats null as "keep the
    // derived title", so returning something is not worse here.
    expect(cleanChatTitle("Here's a summary of it")).toBe("Here's a summary of it")
  })

  it('refuses an outright reasoning monologue rather than falling back to it', () => {
    // Observed in the sidebar as "Here's a thinking pr…": the preamble guard
    // rejected the line, found no other candidate, and the fallback above
    // handed the monologue back. A monologue is never a mediocre title — it is
    // a wrong one, and the derived title is right there.
    expect(cleanChatTitle("Here's a thinking process: 1. Identify the subject")).toBeNull()
    expect(cleanChatTitle('Let me think about what to call this')).toBeNull()
    expect(cleanChatTitle('The user wants a title for their chat')).toBeNull()
  })
})
