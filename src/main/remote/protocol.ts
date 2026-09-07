/**
 * The wire frames between a paired phone and this machine.
 *
 * Shape follows `docs/HANDOFF_REMOTE_MOBILE.md` §3.1, because Anodex's whole IPC
 * surface is already `invoke(channel, ...args) → Promise` plus pushed events, and
 * a protocol that mirrors that maps onto the existing handlers 1:1.
 *
 * Parsing lives here rather than in the socket code so that every malformed frame
 * a hostile client can send is reachable from a unit test.
 */

/** Everything a client may send. */
export type ClientFrame =
  /**
   * `reachedAt` is the address the phone actually dialled to get here.
   *
   * A machine behind a router cannot see its own public address: the router
   * rewrites the packets, and everything this end observes is the private side. The
   * usual answers are to ask an outside service what our address looks like, or to
   * ask the router over NAT-PMP/UPnP — the first is a third party this app has no
   * reason to involve, and the second is refused by a great many home routers.
   *
   * But a phone that connected from outside already knows the answer, because it
   * typed it. So it says. That is local, needs nobody else, and is only believed
   * from a client that has authenticated.
   */
  | {
      type: 'hello'
      protocolVersion: string
      deviceKey: string
      deviceName?: string
      reachedAt?: string
    }
  | {
      type: 'pair'
      protocolVersion: string
      secret: string
      deviceName?: string
      reachedAt?: string
    }
  | { type: 'invoke'; id: string; channel: string; args: unknown[] }
  | { type: 'ping' }

/** Everything the desktop may send. */
export type ServerFrame =
  /**
   * Both handshake replies carry `addresses`: every place this machine can be
   * reached, best first. The phone stores them and tries each on reconnect, which
   * is what lets it work away from home — a LAN address at home, a mesh VPN
   * address anywhere else — without Anodex running a relay (§7.1.3).
   */
  | {
      type: 'welcome'
      deviceId: string
      protocolVersion: string
      addresses: string[]
      /**
       * The phone build this desktop shipped alongside.
       *
       * The desktop knows what it was released with, so it says so and the phone
       * compares. This makes "up to date" mean *matched to this computer* — the more
       * useful meaning, since the two talk over a versioned protocol and a phone
       * running ahead of the machine it drives is not obviously a good thing.
       *
       * It also works before the phone has any internet beyond the LAN, which is a
       * real case: a desktop reachable at home while the phone's data is off.
       */
      mobileVersion: string
      /**
       * What this machine is called.
       *
       * Sent so the phone can show a name rather than an address. A phone paired by
       * typing an address had nothing else to call the machine, so it showed the
       * address on every screen — which is a router's public IP sitting in plain
       * sight on a device that leaves the house.
       *
       * Sent on every handshake rather than only at pairing, so a phone that paired
       * before this existed picks the name up on its next connection instead of
       * having to pair again.
       */
      hostName: string
    }
  | {
      type: 'paired'
      deviceKey: string
      deviceId: string
      protocolVersion: string
      addresses: string[]
      mobileVersion: string
      hostName: string
    }
  | { type: 'result'; id: string; ok: true; result: unknown }
  | { type: 'result'; id: string; ok: false; error: { code: string; message: string } }
  | { type: 'event'; channel: string; payload: unknown; seq: number }
  | { type: 'refused'; code: string; message: string }
  | { type: 'pong' }

/**
 * The largest frame accepted, in bytes.
 *
 * Without a cap, one client can make the desktop allocate without bound simply by
 * never stopping. Generous enough for any command Anodex actually sends; the
 * attachment upload path, when it exists, will need its own chunked route rather
 * than a bigger number here.
 */
export const MAX_FRAME_BYTES = 256 * 1024

/**
 * The most this machine will send in one frame.
 *
 * Separate from, and larger than, `MAX_FRAME_BYTES`, because a *reply* legitimately
 * carries more than a request: a file's contents, a conversation's history. What it
 * must never carry is everything at once.
 *
 * This exists because it did. `conversations:list` returns every conversation with
 * every message, and against a real store that was 123MB of JSON. The phone has a
 * 256MB heap, OkHttp buffers a WebSocket message whole, and the process died with
 * `OutOfMemoryError` inside the socket reader — which is not catchable and takes the
 * app with it. From the user's side that looked like "it won't connect", because the
 * connection succeeded and the app vanished a second later.
 *
 * The channels that caused it are fixed separately. This is the guard that makes the
 * *class* of failure impossible: no reply, from any handler added at any point in the
 * future, can be large enough to kill the client that asked for it.
 */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export type ParsedFrame =
  { ok: true; frame: ClientFrame } | { ok: false; code: string; message: string }

/**
 * Parse an inbound frame. Total, strict, and never throws.
 *
 * Every rejection is named, because a client that is silently ignored waits
 * forever on a reply that is not coming, and the user sees an app that hangs for
 * no visible reason.
 */
export function parseClientFrame(raw: string | Buffer): ParsedFrame {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8')

  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) {
    return { ok: false, code: 'frame-too-large', message: 'That message was too large.' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, code: 'not-json', message: 'That message was not valid JSON.' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: 'not-an-object', message: 'A frame must be a JSON object.' }
  }

  const frame = parsed as Record<string, unknown>
  switch (frame.type) {
    case 'ping':
      return { ok: true, frame: { type: 'ping' } }

    case 'hello': {
      const protocolVersion = asString(frame.protocolVersion)
      const deviceKey = asString(frame.deviceKey)
      if (!protocolVersion || !deviceKey) {
        return { ok: false, code: 'bad-hello', message: 'A hello needs a version and a key.' }
      }
      return {
        ok: true,
        frame: {
          type: 'hello',
          protocolVersion,
          deviceKey,
          deviceName: asString(frame.deviceName),
          reachedAt: asString(frame.reachedAt)
        }
      }
    }

    case 'pair': {
      const protocolVersion = asString(frame.protocolVersion)
      const secret = asString(frame.secret)
      if (!protocolVersion || !secret) {
        return {
          ok: false,
          code: 'bad-pair',
          message: 'A pair request needs a version and a code.'
        }
      }
      return {
        ok: true,
        frame: {
          type: 'pair',
          protocolVersion,
          secret,
          deviceName: asString(frame.deviceName),
          reachedAt: asString(frame.reachedAt)
        }
      }
    }

    case 'invoke': {
      const id = asString(frame.id)
      const channel = asString(frame.channel)
      if (!id || !channel) {
        return { ok: false, code: 'bad-invoke', message: 'An invoke needs an id and a channel.' }
      }
      if (!Array.isArray(frame.args)) {
        // Not defaulted to []. A client that meant to send arguments and got the
        // shape wrong should be told, not have its call silently made with none —
        // that turns a typo into a differently-behaving command.
        return { ok: false, code: 'bad-invoke', message: '`args` must be an array.' }
      }
      return { ok: true, frame: { type: 'invoke', id, channel, args: frame.args } }
    }

    default:
      return { ok: false, code: 'unknown-frame', message: 'Unrecognised message type.' }
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Compare protocol versions by major.
 *
 * A mismatch is refused with a message on both screens rather than left to fail
 * as a hang or a generic disconnect — two repositories drifting into a runtime
 * mismatch with no diagnosable symptom is exactly what the versioned contract
 * exists to prevent (§4).
 */
export function majorVersionOf(version: string): number | null {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isFinite(major) ? major : null
}

export function versionsCompatible(a: string, b: string): boolean {
  const left = majorVersionOf(a)
  const right = majorVersionOf(b)
  return left !== null && right !== null && left === right
}
