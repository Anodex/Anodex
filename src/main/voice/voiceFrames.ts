/**
 * The audio wire format: a fixed 12-byte header and a payload.
 *
 * ## Why this is not JSON
 *
 * Everything else on the bridge is a JSON text frame, and audio deliberately is
 * not. Two reasons, and the second is the one that matters.
 *
 * Base64 inside JSON costs a third more bytes, on the traffic that sends fifty
 * frames a second. That alone would be an argument and not a strong one — the
 * frames are small.
 *
 * The real reason is that it would become a format we had to keep. The bridge's
 * JSON parser buffers, validates and allocates per frame, and its shape is the
 * contract two repositories are written against; putting a continuous audio stream
 * through it would mean either living with that cost forever or changing the wire
 * format later, on a protocol that ships to phones. Doing it as binary on the
 * first commit costs one branch in `RemoteBridge` and nothing afterwards. See
 * `docs/HANDOFF_VOICE.md` D2.
 *
 * ## The header
 *
 * ```
 *   0      1      2      4        8         12
 *   +------+------+------+--------+---------+------------
 *   | ver  | kind | flags| seq    | atMs    | payload
 *   +------+------+------+--------+---------+------------
 *   u8     u8     u16    u32be    u32be
 * ```
 *
 * `atMs` is the sender's own clock, in milliseconds since its session began, and
 * it is **echoed back untouched** by anything that answers a frame. Neither end
 * has to trust the other's clock or agree with it: the sender subtracts its own
 * two readings and gets a round trip. That is the entire measurement stage 1
 * exists to produce, and it costs four bytes.
 *
 * `flags` is reserved and must be zero. It is here because a flag added later
 * without a space reserved for it is a version bump.
 */

/** The only framing version. A frame that says anything else is not read. */
export const VOICE_FRAME_VERSION = 1

/** Bytes before the payload. */
export const VOICE_HEADER_BYTES = 12

/**
 * The largest payload read or written.
 *
 * 20 ms of 24 kHz 16-bit mono is 960 bytes, so this is generous by an order of
 * magnitude and still far below `MAX_FRAME_BYTES`. It exists because the length
 * comes from the network: a cap that is never reached in normal use is the cheapest
 * guard there is.
 */
export const MAX_VOICE_PAYLOAD_BYTES = 8 * 1024

export const VoiceFrameKind = {
  /** PCM samples, or whatever the negotiated audio encoding is. */
  Audio: 1,
  /** A short UTF-8 JSON object: starting, stopping, stop talking. */
  Control: 2
} as const

export type VoiceFrameKind = (typeof VoiceFrameKind)[keyof typeof VoiceFrameKind]

export interface VoiceFrame {
  kind: VoiceFrameKind
  /** Per-session, per-direction, wrapping at 2^32. Gaps mean dropped audio. */
  seq: number
  /** The sender's clock when it built the frame. Meaningful only to the sender. */
  atMs: number
  payload: Buffer
}

export type VoiceFrameParse =
  { ok: true; frame: VoiceFrame } | { ok: false; code: string; message: string }

/**
 * Read a frame, never throwing.
 *
 * Returns a reason rather than a boolean because the caller logs it: a stream that
 * silently stops is the worst thing to debug on a phone in another room, and
 * "voice frame too short" said once is the difference between an afternoon and a
 * minute.
 */
export function parseVoiceFrame(raw: Buffer): VoiceFrameParse {
  if (raw.length < VOICE_HEADER_BYTES) {
    return { ok: false, code: 'voice-frame-short', message: 'A voice frame needs a header.' }
  }

  const version = raw.readUInt8(0)
  if (version !== VOICE_FRAME_VERSION) {
    // Not an error worth closing the connection over: a peer speaking a later
    // framing is a peer whose voice feature this build cannot use, which is what
    // the capability handshake is supposed to have prevented already.
    return { ok: false, code: 'voice-frame-version', message: `Unknown voice framing ${version}.` }
  }

  const kind = raw.readUInt8(1)
  if (kind !== VoiceFrameKind.Audio && kind !== VoiceFrameKind.Control) {
    return { ok: false, code: 'voice-frame-kind', message: `Unknown voice frame kind ${kind}.` }
  }

  if (raw.readUInt16BE(2) !== 0) {
    return { ok: false, code: 'voice-frame-flags', message: 'Reserved flags must be zero.' }
  }

  const payload = raw.subarray(VOICE_HEADER_BYTES)
  if (payload.length > MAX_VOICE_PAYLOAD_BYTES) {
    return { ok: false, code: 'voice-frame-large', message: 'That voice frame was too large.' }
  }

  return {
    ok: true,
    frame: {
      kind,
      seq: raw.readUInt32BE(4),
      atMs: raw.readUInt32BE(8),
      // Copied rather than kept as a view. `ws` hands over a buffer it may reuse,
      // and audio that is held for even one tick — a jitter buffer, a queue —
      // would otherwise be quietly rewritten underneath.
      payload: Buffer.from(payload)
    }
  }
}

/** Build a frame. Throws only on a payload this code should never have produced. */
export function encodeVoiceFrame(frame: VoiceFrame): Buffer {
  if (frame.payload.length > MAX_VOICE_PAYLOAD_BYTES) {
    throw new Error(`Voice payload of ${frame.payload.length} bytes is too large to send.`)
  }

  const header = Buffer.alloc(VOICE_HEADER_BYTES)
  header.writeUInt8(VOICE_FRAME_VERSION, 0)
  header.writeUInt8(frame.kind, 1)
  header.writeUInt16BE(0, 2)
  // Wrapped rather than clamped: both fields are counters read modulo 2^32 by the
  // far end, and a session long enough to wrap `atMs` is 49 days.
  header.writeUInt32BE(frame.seq >>> 0, 4)
  header.writeUInt32BE(frame.atMs >>> 0, 8)
  return Buffer.concat([header, frame.payload])
}

/** A control payload, or null if it was not one. Never throws. */
export function readControl(frame: VoiceFrame): Record<string, unknown> | null {
  if (frame.kind !== VoiceFrameKind.Control) return null
  try {
    const parsed: unknown = JSON.parse(frame.payload.toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Build a control frame. */
export function encodeControl(seq: number, atMs: number, body: Record<string, unknown>): Buffer {
  return encodeVoiceFrame({
    kind: VoiceFrameKind.Control,
    seq,
    atMs,
    payload: Buffer.from(JSON.stringify(body), 'utf8')
  })
}
