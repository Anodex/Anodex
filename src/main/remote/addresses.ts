import { networkInterfaces } from 'node:os'

/**
 * Every address a phone might reach this machine at, best first.
 *
 * The phone stores this list and tries each in turn, which is what makes working
 * away from home possible without Anodex running a relay. A relay is ruled out on
 * purpose (handoff §7.1.3): routing a user's conversations through our
 * infrastructure contradicts the promise the whole product rests on, and even a
 * relay carrying only "host X has news" would mean running a service that learns
 * when each user's agents finish. Metadata is data.
 *
 * The supported answer is the user's own mesh VPN — Tailscale, or any WireGuard
 * network. It makes the LAN case true from anywhere: the desktop keeps a stable
 * address on the tailnet, the phone joins the same one, and nothing about this
 * code path changes. All Anodex has to do is *tell the phone that address exists*,
 * which is the entire job of this file.
 */

/** A place the desktop can be reached, with enough context for the phone to choose. */
export interface HostAddress {
  readonly address: string
  readonly kind: HostAddressKind
  /** Human label for diagnostics and the Settings list. */
  readonly label: string
}

export type HostAddressKind =
  /** A private LAN address. Fastest, and works only at home. */
  | 'lan'
  /** A mesh VPN address — Tailscale and friends. Works anywhere both ends are online. */
  | 'mesh'
  /** A virtual switch or similar. Routes to virtual machines, not to phones. */
  | 'virtual'

/**
 * Tailscale hands out addresses from 100.64.0.0/10, the CGNAT range.
 *
 * Recognising it is what lets the phone prefer a mesh address when it is away
 * from home and a LAN address when it is not — the LAN route is faster and does
 * not depend on either end reaching a coordination server.
 */
function isMeshAddress(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 100 && b >= 64 && b <= 127
}

function isPrivateLan(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  return a === 172 && b >= 16 && b <= 31
}

const VIRTUAL_INTERFACE = /virtual|vethernet|wsl|docker|vmware|hyper-v|bluetooth|loopback/i
const MESH_INTERFACE = /tailscale|wg\d|wireguard|zerotier|tun\d/i

/**
 * Rank an address by how likely it is to actually carry a connection.
 *
 * LAN first: at home it is the fast path and needs nothing else running. Mesh
 * second: slower and dependent on both ends being online, but it works from
 * anywhere, which is the whole point. Virtual switches last and link-local not at
 * all — a 169.254 address means no DHCP server ever answered on that adapter.
 */
export function collectHostAddresses(): HostAddress[] {
  const found: HostAddress[] = []

  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('169.254.')) continue

      const mesh = isMeshAddress(entry.address) || MESH_INTERFACE.test(name)
      const virtual = VIRTUAL_INTERFACE.test(name)

      const kind: HostAddressKind = mesh ? 'mesh' : virtual ? 'virtual' : 'lan'
      if (kind === 'lan' && !isPrivateLan(entry.address)) continue

      found.push({ address: entry.address, kind, label: name })
    }
  }

  const order: Record<HostAddressKind, number> = { lan: 0, mesh: 1, virtual: 2 }
  return found.sort((a, b) => order[a.kind] - order[b.kind])
}

/** The single best address, for the QR and the Settings summary. */
export function primaryHostAddress(): string | null {
  return collectHostAddresses()[0]?.address ?? null
}
