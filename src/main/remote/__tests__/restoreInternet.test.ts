import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What survives closing Anodex.
 *
 * The whole away-from-home feature is a setting the user turns on once and then
 * relies on from a phone in another building. So the failure that matters is not
 * "it did not work" — it is **"it worked until the desktop was restarted, and then
 * silently did not"**, which is discovered days later, from somewhere the user
 * cannot go and fix it.
 *
 * This is the second time that exact shape has bitten this feature: the listener
 * originally bound an ephemeral port, so a paired phone could never reconnect after
 * a restart either.
 */

const paths = new Map<string, string>()

vi.mock('electron', () => ({
  app: { getPath: (name: string) => paths.get(name) ?? tmpdir() },
  safeStorage: {
    // True, because the real service refuses to persist a private key it cannot
    // encrypt — and a mock that says "unavailable" makes every startup fail for a
    // reason that has nothing to do with what is under test.
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

const started = { count: 0, port: 0 }
const mapped: number[] = []

// Only the two functions that talk to a router are replaced. The address
// arithmetic stays real: mocking `isPrivateAddress` would mean the tests below
// prove that a stub returns what it was told to, rather than that a phone on the
// home Wi-Fi is correctly not mistaken for one on the internet.
vi.mock('../natpmp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../natpmp')>()),
  requestPortMapping: vi.fn((port: number) => {
    mapped.push(port)
    return Promise.resolve({
      ok: true as const,
      mapping: {
        externalAddress: '203.0.113.7',
        externalPort: port,
        internalPort: port,
        lifetimeSeconds: 3600
      }
    })
  }),
  releasePortMapping: vi.fn(() => Promise.resolve(undefined))
}))

vi.mock('../RemoteBridge', () => ({
  PROTOCOL_VERSION: '1.0.0',
  RemoteBridge: class {
    listening = false
    port: number | null = null
    start(port: number): Promise<number> {
      started.count += 1
      started.port = port
      this.listening = true
      this.port = port
      return Promise.resolve(port)
    }
    stop(): Promise<void> {
      this.listening = false
      this.port = null
      return Promise.resolve()
    }
  }
}))

vi.mock('../certificate', () => ({
  generateRemoteCertificate: () =>
    Promise.resolve({
      certPem: 'cert',
      privateKeyPem: 'key',
      sha256: 'ff'.repeat(32)
    })
}))

describe('restoring remote access after a restart', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'anodex-remote-'))
    paths.set('userData', directory)
    started.count = 0
    mapped.length = 0
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  /** Writes the file a previous run would have left behind. */
  function persist(state: Record<string, unknown>): void {
    writeFileSync(join(directory, 'remote.json'), JSON.stringify(state), 'utf-8')
  }

  async function freshService() {
    const module = await import('../RemoteService')
    return module.remoteService
  }

  it('asks the router for the port again on startup', async () => {
    // The bug this exists for: `initialize` restored the listener and not the way
    // in from outside, so the setting read as on while the phone was never told the
    // public address again.
    persist({ enabled: true, internetEnabled: true, port: 47800 })

    const service = await freshService()
    await service.initialize()

    expect(mapped, 'no port mapping was requested on startup').toContain(47800)
    expect(service.status().internet.address).toBe('203.0.113.7')
  })

  it('hands the phone the public address after a restart', async () => {
    // This is what the phone actually consumes. An address that is correct in
    // Settings but absent from the handshake helps nobody.
    persist({ enabled: true, internetEnabled: true, port: 47800 })

    const service = await freshService()
    await service.initialize()

    expect(service.externalAddress()).toBe('203.0.113.7')
  })

  it('restores a hand-forwarded address without touching the router', async () => {
    // The path that actually works on a router with UPnP and NAT-PMP switched off,
    // which is most of them.
    persist({
      enabled: true,
      internetEnabled: true,
      port: 47800,
      manualExternalAddress: '198.51.100.4',
      manualExternalPort: 51820
    })

    const service = await freshService()
    await service.initialize()

    expect(service.externalAddress()).toBe('198.51.100.4')
    expect(service.status().internet.port).toBe(51820)
    expect(mapped, 'asked the router despite a manual address being saved').toHaveLength(0)
  })

  it('leaves the port shut when the user never asked for one', async () => {
    // Remote access on, internet access off. Opening a port anyway would expose the
    // machine to a decision the user did not make.
    persist({ enabled: true, port: 47800 })

    const service = await freshService()
    await service.initialize()

    expect(mapped).toHaveLength(0)
    expect(service.externalAddress()).toBeNull()
    expect(service.status().internet.enabled).toBe(false)
  })

  it('does not start anything when remote access itself is off', async () => {
    persist({ enabled: false, internetEnabled: true })

    const service = await freshService()
    await service.initialize()

    expect(started.count).toBe(0)
    expect(mapped).toHaveLength(0)
  })

  it('reuses the saved port, so a paired phone can still find it', async () => {
    persist({ enabled: true, internetEnabled: false, port: 47800 })

    const service = await freshService()
    await service.initialize()

    expect(started.port).toBe(47800)
  })

  /**
   * Whether the port forwarding actually worked.
   *
   * There is no way to answer that from inside the network without asking somebody
   * else's server to look — which is exactly what this feature exists to avoid. But
   * the phone is already an outside observer whenever it is on mobile data, so a
   * connection arriving from a public address *is* the proof, and it costs nothing.
   *
   * Getting this wrong in either direction is bad in a specific way: a false yes
   * tells the user their setup works when it does not, and they will believe it.
   */
  describe('confirming a phone got in from outside', () => {
    it('records a connection that arrived from a public address', async () => {
      persist({ enabled: true, internetEnabled: true, port: 47800 })
      const service = await freshService()
      await service.initialize()

      service.recordPeerAddress('198.51.100.22')

      expect(service.status().internet.lastReachedFromOutsideEpochMs).toBeGreaterThan(0)
    })

    it('ignores a phone on the same Wi-Fi', async () => {
      // The common case, and the one that would produce a false yes: the user is
      // sitting at home when they pair, and nothing about that says the port is open.
      persist({ enabled: true, internetEnabled: true, port: 47800 })
      const service = await freshService()
      await service.initialize()

      for (const address of ['192.168.1.55', '10.0.0.153', '172.20.4.4']) {
        service.recordPeerAddress(address)
      }

      expect(service.status().internet.lastReachedFromOutsideEpochMs).toBeUndefined()
    })

    it('ignores a phone on a mesh VPN, which is not the router doing the work', async () => {
      // 100.64/10 again. A Tailscale peer proves the VPN works and says nothing
      // whatsoever about port forwarding.
      persist({ enabled: true, internetEnabled: true, port: 47800 })
      const service = await freshService()
      await service.initialize()

      service.recordPeerAddress('100.101.102.103')

      expect(service.status().internet.lastReachedFromOutsideEpochMs).toBeUndefined()
    })

    it('understands the IPv4-mapped form Node reports on a dual-stack socket', async () => {
      // `::ffff:198.51.100.22`. Read literally it parses as nothing, and a public
      // connection would be silently discarded — the confirmation would simply never
      // arrive and the user would conclude their forwarding had failed.
      persist({ enabled: true, internetEnabled: true, port: 47800 })
      const service = await freshService()
      await service.initialize()

      service.recordPeerAddress('::ffff:198.51.100.22')

      expect(service.status().internet.lastReachedFromOutsideEpochMs).toBeGreaterThan(0)
    })

    it('does nothing when the peer address is unknown', async () => {
      persist({ enabled: true, internetEnabled: true, port: 47800 })
      const service = await freshService()
      await service.initialize()

      service.recordPeerAddress(undefined)

      expect(service.status().internet.lastReachedFromOutsideEpochMs).toBeUndefined()
    })
  })
})
