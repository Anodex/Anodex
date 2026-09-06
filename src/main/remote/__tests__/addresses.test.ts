import { describe, expect, it, vi, afterEach } from 'vitest'

const networkInterfaces = vi.hoisted(() => vi.fn())
vi.mock('node:os', () => ({ networkInterfaces }))

const { collectHostAddresses, primaryHostAddress } = await import('../addresses')

type Entry = { address: string; family: string; internal: boolean }

function withInterfaces(map: Record<string, Entry[]>): void {
  networkInterfaces.mockReturnValue(map)
}

const ipv4 = (address: string, internal = false): Entry => ({
  address,
  family: 'IPv4',
  internal
})

/**
 * Which addresses the desktop offers a phone.
 *
 * This decides whether working away from home is possible at all: the phone tries
 * these in order, and an address that cannot carry a connection wastes a whole
 * retry cycle before anything else is attempted.
 */
describe('host addresses', () => {
  afterEach(() => networkInterfaces.mockReset())

  it('prefers the LAN, then the mesh, then anything virtual', () => {
    withInterfaces({
      'vEthernet (Default Switch)': [ipv4('172.21.48.1')],
      Tailscale: [ipv4('100.101.102.103')],
      'Wi-Fi 2': [ipv4('10.0.0.153')]
    })

    expect(collectHostAddresses().map((a) => a.address)).toEqual([
      '10.0.0.153',
      '100.101.102.103',
      '172.21.48.1'
    ])
  })

  it('recognises a Tailscale address by its range, whatever the adapter is called', () => {
    // The adapter name is not dependable across platforms and versions, but the
    // CGNAT range Tailscale allocates from is.
    withInterfaces({ 'some-unhelpful-name': [ipv4('100.64.0.1')] })

    expect(collectHostAddresses()[0].kind).toBe('mesh')
  })

  it('does not mistake an ordinary address for a mesh one', () => {
    // 100.x outside 100.64-100.127 is public space, not CGNAT.
    withInterfaces({ eth0: [ipv4('100.63.0.1')], eth1: [ipv4('100.128.0.1')] })

    expect(collectHostAddresses()).toHaveLength(0)
  })

  it('drops link-local addresses entirely', () => {
    // 169.254 means no DHCP server ever answered on that adapter. Offering it
    // guarantees a failed attempt.
    withInterfaces({ Ethernet: [ipv4('169.254.10.1')], 'Wi-Fi': [ipv4('192.168.1.5')] })

    expect(collectHostAddresses().map((a) => a.address)).toEqual(['192.168.1.5'])
  })

  it('drops loopback and anything the OS calls internal', () => {
    withInterfaces({ Loopback: [ipv4('127.0.0.1', true)], 'Wi-Fi': [ipv4('10.1.1.1')] })

    expect(collectHostAddresses().map((a) => a.address)).toEqual(['10.1.1.1'])
  })

  it('keeps the 172.16-172.31 private range and rejects its neighbours', () => {
    withInterfaces({
      a: [ipv4('172.15.0.1')],
      b: [ipv4('172.16.0.1')],
      c: [ipv4('172.31.0.1')],
      d: [ipv4('172.32.0.1')]
    })

    expect(collectHostAddresses().map((a) => a.address)).toEqual(['172.16.0.1', '172.31.0.1'])
  })

  it('offers nothing rather than something unusable when there is nothing', () => {
    withInterfaces({ Loopback: [ipv4('127.0.0.1', true)] })

    expect(collectHostAddresses()).toEqual([])
    expect(primaryHostAddress()).toBeNull()
  })

  it('names a mesh-only machine as reachable', () => {
    // A desktop on a tailnet with no usable LAN - a laptop tethered somewhere, or
    // a machine whose only other adapter is a virtual switch.
    withInterfaces({
      Tailscale: [ipv4('100.90.80.70')],
      'vEthernet (WSL)': [ipv4('172.20.0.1')]
    })

    expect(primaryHostAddress()).toBe('100.90.80.70')
  })
})
