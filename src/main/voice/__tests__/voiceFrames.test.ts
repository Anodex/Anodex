import { describe, expect, it } from 'vitest'
import {
  encodeControl,
  encodeVoiceFrame,
  MAX_VOICE_PAYLOAD_BYTES,
  parseVoiceFrame,
  readControl,
  VOICE_HEADER_BYTES,
  VoiceFrameKind
} from '../voiceFrames'

/**
 * The audio framing.
 *
 * A pure function over bytes, which is the cheapest thing in the whole voice
 * pipeline to be certain about and the most expensive to get wrong later: it is
 * the one piece two repositories have to agree on, and it ships to phones.
 */
describe('a voice frame', () => {
  const audio = Buffer.from([0x11, 0x22, 0x33, 0x44])

  it('comes back as it went in', () => {
    const encoded = encodeVoiceFrame({
      kind: VoiceFrameKind.Audio,
      seq: 7,
      atMs: 123_456,
      payload: audio
    })
    const parsed = parseVoiceFrame(encoded)

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.frame.kind).toBe(VoiceFrameKind.Audio)
    expect(parsed.frame.seq).toBe(7)
    expect(parsed.frame.atMs).toBe(123_456)
    expect(parsed.frame.payload).toEqual(audio)
  })

  it('costs twelve bytes', () => {
    // Pinned because it is the number the phone's encoder is written against.
    const encoded = encodeVoiceFrame({
      kind: VoiceFrameKind.Audio,
      seq: 1,
      atMs: 1,
      payload: audio
    })
    expect(encoded.length).toBe(VOICE_HEADER_BYTES + audio.length)
  })

  it('does not hand back a view of a buffer somebody else owns', () => {
    // `ws` reuses its receive buffer. A payload kept as a view would be rewritten
    // underneath anything that held it for a tick — a jitter buffer, a queue —
    // and the symptom would be audio that is intermittently somebody else's.
    const encoded = encodeVoiceFrame({
      kind: VoiceFrameKind.Audio,
      seq: 1,
      atMs: 1,
      payload: audio
    })
    const parsed = parseVoiceFrame(encoded)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    encoded.fill(0)
    expect(parsed.frame.payload).toEqual(audio)
  })

  it('carries a clock it never interprets', () => {
    // The far end echoes `atMs` untouched so the sender can subtract its own two
    // readings. Nothing may normalise it into this machine's idea of the time.
    const encoded = encodeVoiceFrame({
      kind: VoiceFrameKind.Audio,
      seq: 0,
      atMs: 4_294_967_295,
      payload: Buffer.alloc(0)
    })
    const parsed = parseVoiceFrame(encoded)
    expect(parsed.ok && parsed.frame.atMs).toBe(4_294_967_295)
  })

  it('wraps a counter rather than throwing on one', () => {
    const encoded = encodeVoiceFrame({
      kind: VoiceFrameKind.Audio,
      seq: 4_294_967_296 + 5,
      atMs: 0,
      payload: Buffer.alloc(0)
    })
    expect(parseVoiceFrame(encoded)).toMatchObject({ ok: true, frame: { seq: 5 } })
  })
})

describe('the bytes the phone is written against', () => {
  /**
   * One frame, pinned by hand on both sides.
   *
   * `VoiceFrames.kt` carries the same vector. Two hand-written copies of one
   * format drift silently — the far end cannot read the frame, answers nothing,
   * and the symptom is a loop that never comes back — so both repositories assert
   * the same bytes rather than trusting the copies to stay in step.
   */
  it('lays the header out big-endian, with a little-endian payload', () => {
    const encoded = encodeVoiceFrame({
      kind: VoiceFrameKind.Audio,
      seq: 0x01020304,
      atMs: 0x0a0b0c0d,
      // 0x1234 and 0x5678 as little-endian PCM, which is what a phone sends.
      payload: Buffer.from([0x34, 0x12, 0x78, 0x56])
    })

    expect([...encoded]).toEqual([
      0x01, // version
      0x01, // kind: audio
      0x00,
      0x00, // reserved flags
      0x01,
      0x02,
      0x03,
      0x04, // seq, big-endian
      0x0a,
      0x0b,
      0x0c,
      0x0d, // atMs, big-endian
      0x34,
      0x12,
      0x78,
      0x56 // payload, little-endian samples
    ])
  })
})

describe('a frame that should not be read', () => {
  it('is too short to hold a header', () => {
    expect(parseVoiceFrame(Buffer.alloc(VOICE_HEADER_BYTES - 1))).toMatchObject({
      ok: false,
      code: 'voice-frame-short'
    })
  })

  it('speaks a framing this build does not', () => {
    const encoded = encodeVoiceFrame({
      kind: VoiceFrameKind.Audio,
      seq: 1,
      atMs: 1,
      payload: Buffer.alloc(0)
    })
    encoded.writeUInt8(2, 0)
    expect(parseVoiceFrame(encoded)).toMatchObject({ ok: false, code: 'voice-frame-version' })
  })

  it('is a kind nothing sends', () => {
    const encoded = encodeVoiceFrame({
      kind: VoiceFrameKind.Audio,
      seq: 1,
      atMs: 1,
      payload: Buffer.alloc(0)
    })
    encoded.writeUInt8(99, 1)
    expect(parseVoiceFrame(encoded)).toMatchObject({ ok: false, code: 'voice-frame-kind' })
  })

  it('sets a flag that has no meaning yet', () => {
    // Reserved bits are checked rather than ignored, so that the first build to
    // use one meets a clear refusal instead of a peer silently agreeing to
    // something it did not understand.
    const encoded = encodeVoiceFrame({
      kind: VoiceFrameKind.Audio,
      seq: 1,
      atMs: 1,
      payload: Buffer.alloc(0)
    })
    encoded.writeUInt16BE(1, 2)
    expect(parseVoiceFrame(encoded)).toMatchObject({ ok: false, code: 'voice-frame-flags' })
  })

  it('carries more than any audio frame should', () => {
    const big = Buffer.concat([
      Buffer.alloc(VOICE_HEADER_BYTES),
      Buffer.alloc(MAX_VOICE_PAYLOAD_BYTES + 1)
    ])
    big.writeUInt8(1, 0)
    big.writeUInt8(VoiceFrameKind.Audio, 1)
    expect(parseVoiceFrame(big)).toMatchObject({ ok: false, code: 'voice-frame-large' })
  })
})

describe('a control frame', () => {
  it('round-trips a small object', () => {
    const parsed = parseVoiceFrame(encodeControl(1, 2, { type: 'start' }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(readControl(parsed.frame)).toEqual({ type: 'start' })
  })

  it('is null when the payload is not an object', () => {
    // Never throws: a malformed control is a message that goes unhandled, not a
    // connection that dies.
    const parsed = parseVoiceFrame(
      encodeVoiceFrame({
        kind: VoiceFrameKind.Control,
        seq: 1,
        atMs: 1,
        payload: Buffer.from('["not", "an", "object"]', 'utf8')
      })
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(readControl(parsed.frame)).toBeNull()
  })

  it('is null when the payload is not JSON at all', () => {
    const parsed = parseVoiceFrame(
      encodeVoiceFrame({
        kind: VoiceFrameKind.Control,
        seq: 1,
        atMs: 1,
        payload: Buffer.from([0xff, 0xfe, 0x00])
      })
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(readControl(parsed.frame)).toBeNull()
  })

  it('is null for audio, which is not a control at all', () => {
    const parsed = parseVoiceFrame(
      encodeVoiceFrame({
        kind: VoiceFrameKind.Audio,
        seq: 1,
        atMs: 1,
        payload: Buffer.from('{"type":"start"}', 'utf8')
      })
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(readControl(parsed.frame)).toBeNull()
  })
})
