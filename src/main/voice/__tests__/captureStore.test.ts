import { describe, expect, it } from 'vitest'
import { encodeWav } from '../captureStore'

/**
 * The WAV header, which is the only part of keeping a recording that can be wrong
 * quietly: a file with a bad header opens as noise, or as nothing, and the
 * recogniser being tested gets blamed for it.
 */
describe('writing a recording', () => {
  it('lays out a header a player will recognise', () => {
    const wav = encodeWav(new Float32Array(100))

    expect(wav.subarray(0, 4).toString()).toBe('RIFF')
    expect(wav.subarray(8, 12).toString()).toBe('WAVE')
    expect(wav.subarray(12, 16).toString()).toBe('fmt ')
    expect(wav.subarray(36, 40).toString()).toBe('data')
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(16_000)
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
  })

  it('states its own length twice, consistently', () => {
    // Both lengths are in the header and a player will believe either. A file
    // that disagrees with itself plays the right audio followed by garbage.
    const wav = encodeWav(new Float32Array(100))
    expect(wav.readUInt32LE(40)).toBe(200)
    expect(wav.readUInt32LE(4)).toBe(36 + 200)
    expect(wav.length).toBe(44 + 200)
  })

  it('clamps rather than wrapping', () => {
    // A sample above 1 wraps to a loud click, and a click at the join is exactly
    // what a recogniser hears as a word.
    const wav = encodeWav(Float32Array.from([2, -2]))
    expect(wav.readInt16LE(44)).toBe(32767)
    expect(wav.readInt16LE(46)).toBe(-32767)
  })

  it('writes silence as silence', () => {
    const wav = encodeWav(new Float32Array(10))
    for (let i = 0; i < 10; i += 1) expect(wav.readInt16LE(44 + i * 2)).toBe(0)
  })
})
