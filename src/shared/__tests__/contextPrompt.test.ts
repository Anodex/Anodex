import { describe, expect, it } from 'vitest'
import { buildCompactionSystemPrompt } from '../contextPrompt'

/**
 * The compaction summary has to read as *this* conversation's own past.
 *
 * Measured: a thirteen-turn chat at an 8,192-token window planted the codeword
 * PERISCOPE-88 in turn one and buried it under about ninety thousand characters
 * of long answers. Compaction carried it through — the fact was still in the
 * model's context at turn thirteen, which is the mechanism working. But asked
 * for the codeword, the model answered:
 *
 *   "no codeword was given at the start of *this* conversation... There is one
 *    codeword in my context — PERISCOPE-88 — but it comes from a summary of an
 *    earlier, separate conversation."
 *
 * The header said "Summary of earlier conversation", and "earlier conversation"
 * reads as *a different* conversation. So the model had the right answer,
 * believed it belonged to someone else's thread, and declined to give it. The
 * content survived and the provenance did not, which is arguably worse than
 * losing it: the user is told their own earlier message never happened.
 */
describe('buildCompactionSystemPrompt', () => {
  const summary = 'The user gave the codeword PERISCOPE-88.'

  it('says the summary is this conversation, not another one', () => {
    const prompt = buildCompactionSystemPrompt(undefined, summary)
    expect(prompt).toMatch(/this conversation/i)
  })

  it('never calls it an "earlier conversation", which reads as a separate thread', () => {
    const prompt = buildCompactionSystemPrompt(undefined, summary)
    expect(prompt).not.toMatch(/earlier conversation/i)
    expect(prompt).not.toMatch(/separate conversation/i)
  })

  it('says the summarised turns really were said here, so they can be attributed', () => {
    // The failure was not a missing fact but a refused attribution: the model
    // would not credit the user with something it believed it read elsewhere.
    const prompt = buildCompactionSystemPrompt(undefined, summary)
    expect(prompt).toMatch(/said|told|happened|took place|exchanged/i)
  })

  it('still carries the summary text itself', () => {
    expect(buildCompactionSystemPrompt(undefined, summary)).toContain(summary)
  })

  // Assembly structure (separator, no-system-prompt case) is covered in
  // `src/main/llama/__tests__/compaction.test.ts`; this file stays on what the
  // header has to say.
})
