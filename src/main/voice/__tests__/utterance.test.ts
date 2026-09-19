import { describe, expect, it } from 'vitest'
import { DEFAULT_UTTERANCE, UtteranceAssembler, type Utterance } from '../utterance'

/**
 * Where one thing somebody said ends and the next begins.
 *
 * Every mistake this can make is invisible in a log and obvious to a person: a
 * sentence cut in half arrives at the model as two fragments and comes back as two
 * wrong answers; two sentences run together arrive as one question nobody asked.
 */
describe('assembling what was said', () => {
  /** 20 ms of 24 kHz 16-bit mono, which is one frame on the wire. */
  function frame(value = 8000): Buffer {
    const samples = 480
    const pcm = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(value, i * 2)
    return pcm
  }

  function collect(): { heard: Utterance[]; assembler: UtteranceAssembler } {
    const heard: Utterance[] = []
    return { heard, assembler: new UtteranceAssembler((u) => heard.push(u)) }
  }

  /** Feed `count` consecutive frames starting at `fromMs` on the sender's clock. */
  function speak(assembler: UtteranceAssembler, count: number, fromMs = 0, arrival = 0): number {
    let at = fromMs
    for (let i = 0; i < count; i += 1) {
      assembler.accept(frame(), at, arrival + (at - fromMs))
      at += 20
    }
    return at
  }

  it('hands over nothing until there is a gap', () => {
    const { heard, assembler } = collect()
    speak(assembler, 50) // one second, still going
    expect(heard).toHaveLength(0)
    expect(assembler.open).toBe(true)
  })

  it("closes on the sender's own silence", () => {
    const { heard, assembler } = collect()
    const end = speak(assembler, 50)
    // 700 ms later, past the 600 ms endpoint.
    assembler.accept(frame(), end + 700, end + 700)

    expect(heard).toHaveLength(1)
    expect(heard[0].frames).toBe(50)
    expect(heard[0].samples.length).toBe(50 * 320) // 480 at 24k becomes 320 at 16k
  })

  it('keeps a sentence together across a pause for breath', () => {
    // 400 ms is a comma, not a full stop. The phone's own gate has a 300 ms
    // hangover, so treating anything above that as the end would split sentences
    // at exactly the point the phone stopped sending.
    const { heard, assembler } = collect()
    const end = speak(assembler, 25)
    speak(assembler, 25, end + 400, end + 400)

    expect(heard).toHaveLength(0)
    expect(assembler.open).toBe(true)
  })

  it("measures the gap by the sender's clock, not by arrival", () => {
    // The round trip on this LAN varies from 16 to 233 ms, which is most of an
    // endpoint. Judging by arrival would cut sentences in half on a bad
    // connection and nowhere else, which is the worst kind of bug to reproduce.
    const { heard, assembler } = collect()
    speak(assembler, 10)

    // Sent 100 ms after the last frame; arrived two seconds late.
    assembler.accept(frame(), 300, 2_500)

    expect(heard).toHaveLength(0)
    expect(assembler.open).toBe(true)
  })

  it('notices the phone stopping mid-sentence', () => {
    // No frame arrives, so there is no sender's clock to compare — only a timer
    // sees this.
    const { heard, assembler } = collect()
    speak(assembler, 30, 0, 1_000)

    assembler.tick(1_000 + 30 * 20 + 700)

    expect(heard).toHaveLength(1)
    expect(heard[0].frames).toBe(30)
  })

  it('does nothing on a tick while speech is still arriving', () => {
    const { heard, assembler } = collect()
    speak(assembler, 30, 0, 1_000)
    assembler.tick(1_000 + 30 * 20 + 100)
    expect(heard).toHaveLength(0)
  })

  it('throws away a noise too short to be a word', () => {
    // A door, a knock, a chair. Transcribing those produces confident nonsense,
    // which is worse than silence because it reads as something somebody said.
    const { heard, assembler } = collect()
    speak(assembler, 5) // 100 ms, under the 250 ms floor
    assembler.flush()
    expect(heard).toHaveLength(0)
  })

  it('does not let a run of noises add up to a sentence', () => {
    // The buffer is cleared before the length is judged, so three separate 100 ms
    // noises stay three noises.
    const { heard, assembler } = collect()
    let at = 0
    for (let i = 0; i < 3; i += 1) {
      at = speak(assembler, 5, at)
      at += 700
    }
    assembler.flush()
    expect(heard).toHaveLength(0)
  })

  it('closes an utterance that has run past the model window', () => {
    // A microphone left on beside a television is speech by every test this code
    // applies. A recogniser handed more than its window drops the end silently,
    // and the end is the part still being said.
    const { heard, assembler } = collect()
    speak(assembler, Math.ceil(DEFAULT_UTTERANCE.maxMs / 20) + 10)

    expect(heard.length).toBeGreaterThanOrEqual(1)
    expect(heard[0].samples.length / 16_000).toBeLessThanOrEqual(
      DEFAULT_UTTERANCE.maxMs / 1000 + 0.05
    )
  })

  it("carries the sender's clock at both ends", () => {
    const { heard, assembler } = collect()
    speak(assembler, 50, 5_000)
    assembler.flush()

    expect(heard[0].startedAtMs).toBe(5_000)
    expect(heard[0].endedAtMs).toBe(5_000 + 49 * 20)
  })

  it('resamples to what the front end expects', () => {
    // 24 kHz in, 16 kHz out, because that is the ratio the phone captures at and
    // the rate every recogniser in the plan was trained on.
    const { heard, assembler } = collect()
    speak(assembler, 50)
    assembler.flush()

    const seconds = heard[0].samples.length / 16_000
    expect(seconds).toBeCloseTo(1.0, 2)
  })

  it('ignores a frame with no audio in it', () => {
    const { heard, assembler } = collect()
    assembler.accept(Buffer.alloc(0), 0, 0)
    assembler.accept(Buffer.alloc(1), 20, 20)
    expect(assembler.open).toBe(false)
    expect(heard).toHaveLength(0)
  })

  it('delivers what was in hand when the session ends', () => {
    const { heard, assembler } = collect()
    speak(assembler, 50)
    assembler.flush()
    expect(heard).toHaveLength(1)
  })

  it('throws away a part-built utterance on reset', () => {
    // Used when a connection drops: whatever was half-said belongs to a session
    // that no longer exists.
    const { heard, assembler } = collect()
    speak(assembler, 50)
    assembler.reset()
    assembler.flush()
    expect(heard).toHaveLength(0)
  })
})
