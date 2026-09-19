import type { ClientChannel } from '../clients/ClientChannel'
import { hasCapability } from '../remote/capabilities'
import { createLogger } from '../utils/logger'
import { VOICE_CAPABILITY, voiceEnabled } from './voiceCapability'
import {
  encodeControl,
  encodeVoiceFrame,
  parseVoiceFrame,
  readControl,
  VoiceFrameKind,
  type VoiceFrame
} from './voiceFrames'

const log = createLogger('voice')

/**
 * Stage 1: the loop, with no models in it.
 *
 * Audio arrives from the phone and goes straight back out again, header intact.
 * That sounds like a toy and is the most valuable thing in the whole project to
 * build first, because it measures the part nobody can estimate: what a real phone
 * over a real network actually costs, before a single weight is downloaded. Every
 * later stage adds work *inside* this loop, so a loop that is already too slow is
 * a plan that was never going to work — and one afternoon here is cheaper than
 * finding that out at stage 3.
 *
 * The phone times the round trip itself, from the `atMs` it put in the header and
 * gets back untouched. This end deliberately does not measure: a number computed
 * from two clocks is a number about the clocks.
 *
 * See `docs/HANDOFF_VOICE.md` §10.
 */

/**
 * The most audio frames accepted in one second, and the most that may arrive at
 * once.
 *
 * Audio is 50 frames a second. This allows four times that, which absorbs a phone
 * catching up after a stall without letting an authenticated client turn the
 * socket into an amplifier by echoing at whatever rate it likes. Excess is dropped
 * rather than refused, because dropping audio is what every layer below already
 * does when it cannot keep up.
 */
const MAX_FRAMES_PER_SECOND = 200
const BURST_FRAMES = 100

interface VoiceSession {
  /** Tokens left in this second's allowance. */
  allowance: number
  /** When the allowance was last topped up. */
  refilledAt: number
  framesIn: number
  framesOut: number
  bytesIn: number
  droppedRate: number
  droppedBad: number
  startedAt: number
}

/**
 * Keyed by the channel object rather than by an id, so a disconnected client's
 * session is collected without anything having to remember to remove it. A voice
 * session that outlived its socket would be a leak on the one path that runs fifty
 * times a second.
 */
const sessions = new WeakMap<ClientChannel, VoiceSession>()

function sessionFor(client: ClientChannel, now: number): VoiceSession {
  const existing = sessions.get(client)
  if (existing) return existing

  const created: VoiceSession = {
    allowance: BURST_FRAMES,
    refilledAt: now,
    framesIn: 0,
    framesOut: 0,
    bytesIn: 0,
    droppedRate: 0,
    droppedBad: 0,
    startedAt: now
  }
  sessions.set(client, created)
  return created
}

function withinRate(session: VoiceSession, now: number): boolean {
  const elapsed = now - session.refilledAt
  if (elapsed > 0) {
    session.allowance = Math.min(
      BURST_FRAMES,
      session.allowance + (elapsed * MAX_FRAMES_PER_SECOND) / 1000
    )
    session.refilledAt = now
  }
  if (session.allowance < 1) return false
  session.allowance -= 1
  return true
}

/**
 * Whether this connection may send audio at all.
 *
 * Both ends have to have said so. The capability check is not decoration: it is
 * what stops a phone that never announced voice from opening an audio path, and
 * what makes the feature removable from either side alone (§9.4).
 */
export function voiceAllowed(client: ClientChannel): boolean {
  return voiceEnabled() && hasCapability(client.capabilities, VOICE_CAPABILITY)
}

/**
 * Handle one binary frame from a phone.
 *
 * `reply` sends a binary frame back on the same socket. Passed in rather than
 * reached for, so that everything here is testable without a socket and so the
 * bridge keeps owning what it means to write to one.
 */
export function handleVoiceFrame(
  client: ClientChannel,
  raw: Buffer,
  reply: (frame: Buffer) => void,
  now: number = Date.now()
): void {
  if (!voiceAllowed(client)) {
    // Silence rather than a refusal. A client sending audio it never announced is
    // either confused or probing, and answering either one per frame is its own
    // amplification.
    return
  }

  const session = sessionFor(client, now)

  const parsed = parseVoiceFrame(raw)
  if (!parsed.ok) {
    session.droppedBad += 1
    // Once per session, not once per frame: fifty a second would bury the log
    // that is supposed to explain the problem.
    if (session.droppedBad === 1) {
      log.warn(`${client.id}: ${parsed.message} (${parsed.code}) — further ones counted only`)
    }
    return
  }

  if (!withinRate(session, now)) {
    session.droppedRate += 1
    if (session.droppedRate === 1) {
      log.warn(`${client.id}: voice frames arriving faster than ${MAX_FRAMES_PER_SECOND}/s`)
    }
    return
  }

  const frame = parsed.frame
  session.framesIn += 1
  session.bytesIn += frame.payload.length

  if (frame.kind === VoiceFrameKind.Control) {
    handleControl(client, session, frame, reply, now)
    return
  }

  // The echo. `seq` and `atMs` go back exactly as they arrived — the phone is
  // timing itself, and a header rewritten here would be a measurement of this
  // code's clock instead.
  reply(
    encodeVoiceFrame({
      kind: VoiceFrameKind.Audio,
      seq: frame.seq,
      atMs: frame.atMs,
      payload: frame.payload
    })
  )
  session.framesOut += 1
}

function handleControl(
  client: ClientChannel,
  session: VoiceSession,
  frame: VoiceFrame,
  reply: (frame: Buffer) => void,
  now: number
): void {
  const body = readControl(frame)
  const type = typeof body?.type === 'string' ? body.type : null

  switch (type) {
    case 'start': {
      session.framesIn = 1
      session.framesOut = 0
      session.bytesIn = 0
      session.droppedRate = 0
      session.droppedBad = 0
      session.startedAt = now
      log.info(`${client.id}: voice started`)
      // Answered so the phone knows the far end is listening before it spends
      // battery on a microphone. An unanswered start is indistinguishable from a
      // desktop that has voice switched off.
      reply(encodeControl(frame.seq, frame.atMs, { type: 'started', echo: true }))
      return
    }

    case 'stop': {
      const seconds = Math.max(1, Math.round((now - session.startedAt) / 1000))
      log.info(
        `${client.id}: voice stopped after ${seconds}s — ` +
          `${session.framesIn} in, ${session.framesOut} out, ` +
          `${Math.round(session.bytesIn / 1024)}KB, ` +
          `${session.droppedRate} dropped for rate, ${session.droppedBad} unreadable`
      )
      reply(encodeControl(frame.seq, frame.atMs, { type: 'stopped' }))
      return
    }

    default:
      // An unknown control is a newer phone asking for something this build does
      // not do. Ignored on purpose: that is the same tolerance the capability
      // handshake exists to provide, one layer down.
      return
  }
}
