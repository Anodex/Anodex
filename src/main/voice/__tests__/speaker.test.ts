import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => (name === 'temp' ? '/tmp' : '/userData')
  }
}))

const { silencePcm, wavHeader, SPEECH_RATE } = await import('../Speaker')

/**
 * The parts of speaking that are arithmetic.
 *
 * Generating audio needs a two-gigabyte model and a GPU, so it is not something a
 * test suite should do. What a test can pin is everything around it: the header a
 * player has to believe, the silence that carries the pauses, and the rate the
 * phone is written against. Each is the kind of thing that fails quietly — a wav
 * that plays as noise, a pause that is twice as long as intended — rather than
 * throwing.
 */
describe('the audio a reply becomes', () => {
  it('is at the rate the phone captures and plays at', () => {
    // Not a coincidence, and not free to change: the phone records at 24 kHz and
    // the model produces 24 kHz, so nothing in the middle has to resample.
    expect(SPEECH_RATE).toBe(24_000)
  })

  it('makes silence of the length asked for', () => {
    // 420 ms is the pause after a sentence. Two bytes a sample, so the arithmetic
    // is worth checking once rather than trusting: a pause of the wrong length is
    // audible and looks like the prosody work failing.
    expect(silencePcm(420).length).toBe(Math.round(SPEECH_RATE * 0.42) * 2)
    expect(silencePcm(0).length).toBe(0)
  })

  it('writes a header a player will believe', () => {
    const header = wavHeader(2000)
    expect(header.subarray(0, 4).toString()).toBe('RIFF')
    expect(header.subarray(8, 12).toString()).toBe('WAVE')
    expect(header.subarray(36, 40).toString()).toBe('data')
    expect(header.readUInt16LE(20)).toBe(1) // PCM
    expect(header.readUInt16LE(22)).toBe(1) // mono
    expect(header.readUInt32LE(24)).toBe(SPEECH_RATE)
    expect(header.readUInt16LE(34)).toBe(16)
  })

  it('states its own length twice, consistently', () => {
    // Both numbers are in the header and a player will believe either. A file
    // that disagrees with itself plays the right audio followed by garbage.
    const header = wavHeader(2000)
    expect(header.readUInt32LE(40)).toBe(2000)
    expect(header.readUInt32LE(4)).toBe(36 + 2000)
  })

  it('describes an empty recording without lying about it', () => {
    const header = wavHeader(0)
    expect(header.readUInt32LE(40)).toBe(0)
    expect(header.readUInt32LE(4)).toBe(36)
  })
})
