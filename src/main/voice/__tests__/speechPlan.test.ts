import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPEECH_PLAN,
  PAUSES,
  planSpeech,
  plannedSilenceMs,
  type SpeechChunk
} from '../speechPlan'

/**
 * Where the silence goes.
 *
 * Everything here is audible. A pause in the wrong place does not fail a build or
 * throw — it makes a version number sound like two sentences, or runs a question
 * into the answer, and the only symptom is that somebody says it sounds off and
 * cannot say why. So the rules are pinned with the reason written down.
 */
const say = (chunks: SpeechChunk[]) => chunks.map((c) => c.text)

describe('breaking a reply into things to say', () => {
  it('gives each sentence its own chunk', () => {
    // Not only for the pause. A model generating one sentence gives it a shape —
    // a rise on a question, a fall on a stop — that the same sentence never gets
    // when it is buried in the middle of a paragraph.
    const plan = planSpeech('The tests pass. I opened a pull request.')
    expect(say(plan)).toEqual(['The tests pass.', 'I opened a pull request.'])
    expect(plan[0].pauseAfterMs).toBe(PAUSES.sentence)
  })

  it('leaves no silence after the last thing said', () => {
    // Silence at the end is not a pause, it is latency: the screen waits for
    // audio that is already over.
    const plan = planSpeech('All done.')
    expect(plan.at(-1)?.pauseAfterMs).toBe(0)
  })

  it('holds a longer beat between paragraphs', () => {
    const plan = planSpeech('First thought.\n\nSecond thought.')
    expect(plan[0].pauseAfterMs).toBe(PAUSES.paragraph)
  })

  it('opens with a short chunk, then settles into longer ones', () => {
    // Nothing is heard until the first chunk exists, so its length is the time to
    // first word. Afterwards generation runs ahead of playback and length is free.
    const long =
      'This opening sentence is deliberately long enough to be split because it runs well past the first chunk limit.'
    const plan = planSpeech(`${long} A second sentence follows it here.`)
    const firstWords = plan[0].text.split(' ').length
    expect(firstWords).toBeLessThanOrEqual(DEFAULT_SPEECH_PLAN.firstChunkWords)
  })
})

describe('full stops that are not full stops', () => {
  // The most audible failure available here. Each of these, read wrong, turns one
  // thing into two and no amount of good prosody survives it.

  it('does not stop inside a version number', () => {
    const plan = planSpeech('Desktop 0.10.15 is published.')
    expect(say(plan)).toEqual(['Desktop 0.10.15 is published.'])
  })

  it('does not stop inside a filename', () => {
    const plan = planSpeech('It lives in voiceLoop.kt and the test is beside it.')
    expect(plan).toHaveLength(1)
  })

  it('does not stop inside a decimal', () => {
    const plan = planSpeech('It runs at 3.6 times realtime.')
    expect(plan).toHaveLength(1)
  })

  it('does not stop on an abbreviation', () => {
    const plan = planSpeech('Dr. Shaw asked for it. It is done.')
    expect(say(plan)).toEqual(['Dr. Shaw asked for it.', 'It is done.'])
  })

  it('does not stop on e.g. or i.e.', () => {
    const plan = planSpeech('Several models, e.g. Whisper, do this. Others do not.')
    expect(plan).toHaveLength(2)
  })

  it('still stops at the end of a real sentence', () => {
    const plan = planSpeech('Version 0.10.15 shipped. Nothing else changed.')
    expect(plan).toHaveLength(2)
  })

  it('keeps a closing quote with the sentence it closes', () => {
    // "It works." — the quote belongs before the pause, or the pause lands
    // between the word and its own punctuation.
    const plan = planSpeech('He said "it works." Then he left.')
    expect(plan[0].text.endsWith('"')).toBe(true)
  })
})

describe('sentences too long to say in one breath', () => {
  it('breaks at a comma before anywhere else', () => {
    // A comma is where the writer already said there was a joint. Breaking
    // anywhere else is guessing.
    const sentence =
      'The gate opens after you have started talking, which means the first consonant is already gone, and that is why the recogniser heard Mind instead of Remind.'
    const plan = planSpeech(sentence, { firstChunkWords: 12, maxChunkWords: 12 })
    expect(plan.length).toBeGreaterThan(1)
    for (const chunk of plan.slice(0, -1)) {
      expect(/[,;:]$/.test(chunk.text)).toBe(true)
    }
  })

  it('falls back to word count when there is nowhere better', () => {
    const sentence = `${'word '.repeat(60)}`.trim()
    const plan = planSpeech(sentence, { firstChunkWords: 10, maxChunkWords: 10 })
    expect(plan.length).toBeGreaterThan(1)
    // Held only briefly: this is a breath somebody took mid-thought, not a stop.
    expect(plan[0].pauseAfterMs).toBe(PAUSES.breath)
  })

  it('pauses longer after a colon than after a comma', () => {
    // Something follows a colon, and the voice should say so by waiting.
    const plan = planSpeech(
      'Three things need to happen: the model, the reducer, and the voice itself, which is the long one.',
      { firstChunkWords: 6, maxChunkWords: 6 }
    )
    const colon = plan.find((c) => c.text.endsWith(':'))
    const comma = plan.find((c) => c.text.endsWith(','))
    expect(colon?.pauseAfterMs).toBe(PAUSES.clause)
    expect(comma?.pauseAfterMs).toBe(PAUSES.comma)
  })
})

describe('nothing to say', () => {
  it('plans nothing for an empty string', () => {
    // A caller that generates audio for nothing wastes a model call and produces
    // a click.
    expect(planSpeech('')).toEqual([])
    expect(planSpeech('   \n\n  ')).toEqual([])
  })
})

describe('how much silence it adds', () => {
  it('adds a fraction that leaves room for the speech to breathe', () => {
    // A note on what this is NOT. A read-aloud that sounds considered measured
    // as "silent 42% of the time" — but that figure counts every frame below a
    // loudness threshold, which includes the gaps between words and the stops
    // inside consonants. Most of it is already in any model's output.
    //
    // What is planned here is silence *added on top of that*, so the two numbers
    // are not comparable and an early version of this test wrongly demanded they
    // match. The bound below is what the plan can honestly promise: enough to be
    // heard as punctuation, not so much that the voice sounds hesitant. Whether
    // the result actually sounds right is settled by measuring generated audio,
    // which is a different test with a microphone at the end of it.
    const reply = [
      'The tests pass, and the round trip came out at 158 milliseconds.',
      'That is about twice what I budgeted for the two hops.',
      '',
      'It is not fatal. But it is margin I was counting on elsewhere, so the honest target is nearer 900 milliseconds than 800.'
    ].join('\n')

    const plan = planSpeech(reply)
    const spokenWords = plan.reduce((n, c) => n + c.text.split(' ').length, 0)
    // Speech runs about 190 words a minute, so estimate the audio from the words.
    const spokenMs = (spokenWords / 190) * 60_000
    const silence = plannedSilenceMs(plan)
    const ratio = silence / (silence + spokenMs)

    expect(ratio).toBeGreaterThan(0.06)
    expect(ratio).toBeLessThan(0.2)
  })
})
