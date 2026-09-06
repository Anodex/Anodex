import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

/**
 * NAT-PMP and PCP port mapping, implemented directly.
 *
 * No dependency: both are small binary protocols over UDP to the router, and a
 * library for them would be more code in `node_modules` than the protocol is on
 * the wire. `dgram` is all this needs.
 *
 * ## What this is for, and what it costs
 *
 * Asking the router to forward a port makes the listener reachable from the
 * internet rather than only from the LAN. That is the point — it is how a phone
 * on mobile data reaches the desktop without anyone else's server in the middle.
 *
 * It is also a genuine increase in exposure, and the honest version of that is:
 * the pairing handshake is what stands between the open port and the machine.
 * Nothing can invoke anything without a 256-bit device key, attempts are capped
 * and then locked out, TLS is pinned, and one device is paired at a time. That is
 * a strong door. But it is now a door onto the internet, where it will be found
 * by scanners within hours rather than by whoever is on the sofa — so every bug
 * behind it is worth more to an attacker than it was.
 *
 * `RemoteService` therefore keeps this **off unless the user asks for it**,
 * separately from turning the listener on.
 */

/** NAT-PMP and PCP both listen here. */
const GATEWAY_PORT = 5351

const NATPMP_VERSION = 0
const OP_EXTERNAL_ADDRESS = 0
const OP_MAP_TCP = 2

/** Router replies set the high bit of the opcode. */
const RESPONSE_FLAG = 128

/**
 * How long a mapping is requested for.
 *
 * Deliberately short and renewed while the listener runs, so a crash or a power
 * cut leaves the router closing the hole on its own within the hour rather than
 * leaving it open indefinitely. A mapping that outlives the program that asked
 * for it is the classic UPnP complaint, and it is avoidable.
 */
export const MAPPING_LIFETIME_SECONDS = 3600

const REQUEST_TIMEOUT_MS = 1500

export interface PortMapping {
  /** The address the outside world reaches this machine on. */
  readonly externalAddress: string
  readonly externalPort: number
  readonly internalPort: number
  /** Seconds the router agreed to, which may be less than asked for. */
  readonly lifetimeSeconds: number
}

/** Why a mapping could not be made. Each maps to something different to tell the user. */
export type PortMappingFailure =
  /** No router replied. NAT-PMP is often simply not enabled. */
  | { reason: 'no-gateway'; message: string }
  /** A router replied and said no — usually UPnP/NAT-PMP disabled in its settings. */
  | { reason: 'refused'; message: string }
  /**
   * The router's own address is private, so this network is behind another NAT.
   *
   * Carrier-grade NAT, and no amount of port forwarding fixes it: the address the
   * router would forward from is not reachable from the internet either.
   */
  | { reason: 'double-nat'; message: string; observed: string }

export type PortMappingResult =
  { ok: true; mapping: PortMapping } | { ok: false; failure: PortMappingFailure }

/** The default gateway, guessed from the interface the LAN address sits on. */
export function guessGateway(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const octets = entry.address.split('.').map(Number)
      if (octets.length !== 4) continue

      const isPrivate =
        octets[0] === 10 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      if (!isPrivate) continue

      // Routers sit at .1 essentially without exception on a home network. A wrong
      // guess costs one timed-out request, not a wrong mapping.
      return `${octets[0]}.${octets[1]}.${octets[2]}.1`
    }
  }
  return null
}

/** Ask the router for its public address and a TCP mapping for `port`. */
export async function requestPortMapping(
  port: number,
  gateway = guessGateway()
): Promise<PortMappingResult> {
  if (!gateway) {
    return {
      ok: false,
      failure: { reason: 'no-gateway', message: 'No router was found on this network.' }
    }
  }

  const external = await sendNatPmp(gateway, buildExternalAddressRequest())
  if (!external) {
    return {
      ok: false,
      failure: {
        reason: 'no-gateway',
        message:
          'Your router did not answer. Port forwarding (NAT-PMP or UPnP) may be turned off in ' +
          'its settings.'
      }
    }
  }

  const externalAddress = parseExternalAddress(external)
  if (!externalAddress) {
    return {
      ok: false,
      failure: { reason: 'refused', message: 'Your router refused to report its public address.' }
    }
  }

  if (isPrivateAddress(externalAddress)) {
    return {
      ok: false,
      failure: {
        reason: 'double-nat',
        observed: externalAddress,
        message:
          `Your router's own address (${externalAddress}) is a private one, so your internet ` +
          'provider is sharing it between customers. Opening a port cannot work on this ' +
          'connection — nothing outside can reach it.'
      }
    }
  }

  const mapped = await sendNatPmp(gateway, buildMapRequest(port))
  if (!mapped) {
    return {
      ok: false,
      failure: { reason: 'no-gateway', message: 'Your router stopped answering mid-request.' }
    }
  }

  const mapping = parseMapResponse(mapped, externalAddress, port)
  if (!mapping) {
    return {
      ok: false,
      failure: {
        reason: 'refused',
        message: 'Your router declined to open the port. Check that UPnP or NAT-PMP is enabled.'
      }
    }
  }

  return { ok: true, mapping }
}

/**
 * Withdraw a mapping.
 *
 * A lifetime of zero is how NAT-PMP says "close it". Called when the listener
 * stops and on quit, because leaving the hole open after Anodex is gone is the
 * behaviour that gives automatic port forwarding its bad name.
 */
export async function releasePortMapping(port: number, gateway = guessGateway()): Promise<void> {
  if (!gateway) return
  await sendNatPmp(gateway, buildMapRequest(port, 0))
}

function buildExternalAddressRequest(): Buffer {
  return Buffer.from([NATPMP_VERSION, OP_EXTERNAL_ADDRESS])
}

function buildMapRequest(port: number, lifetime = MAPPING_LIFETIME_SECONDS): Buffer {
  const message = Buffer.alloc(12)
  message.writeUInt8(NATPMP_VERSION, 0)
  message.writeUInt8(OP_MAP_TCP, 1)
  message.writeUInt16BE(0, 2) // reserved
  message.writeUInt16BE(port, 4) // internal port
  // Asking for the same number outside keeps the address the phone was told stable
  // across renewals; the router may hand back a different one, which is honoured.
  message.writeUInt16BE(port, 6)
  message.writeUInt32BE(lifetime, 8)
  return message
}

export function parseExternalAddress(reply: Buffer): string | null {
  if (reply.length < 12) return null
  if (reply.readUInt8(1) !== OP_EXTERNAL_ADDRESS + RESPONSE_FLAG) return null
  if (reply.readUInt16BE(2) !== 0) return null // non-zero result code is a refusal
  return `${reply.readUInt8(8)}.${reply.readUInt8(9)}.${reply.readUInt8(10)}.${reply.readUInt8(11)}`
}

export function parseMapResponse(
  reply: Buffer,
  externalAddress: string,
  internalPort: number
): PortMapping | null {
  if (reply.length < 16) return null
  if (reply.readUInt8(1) !== OP_MAP_TCP + RESPONSE_FLAG) return null
  if (reply.readUInt16BE(2) !== 0) return null

  const lifetimeSeconds = reply.readUInt32BE(12)
  // A zero lifetime in a reply means the mapping was removed, not created.
  if (lifetimeSeconds === 0) return null

  return {
    externalAddress,
    externalPort: reply.readUInt16BE(10),
    internalPort,
    lifetimeSeconds
  }
}

export function isPrivateAddress(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return true
  }

  const [a, b] = octets
  return (
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    // 100.64/10 is carrier-grade NAT — the address a shared-IP customer sees.
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    a === 0
  )
}

function sendNatPmp(gateway: string, message: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    let settled = false

    const finish = (reply: Buffer | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // Already closed.
      }
      resolve(reply)
    }

    const timer = setTimeout(() => finish(null), REQUEST_TIMEOUT_MS)
    timer.unref?.()

    socket.on('message', (reply) => finish(reply))
    socket.on('error', () => finish(null))
    socket.send(message, GATEWAY_PORT, gateway, (error) => {
      if (error) finish(null)
    })
  })
}
