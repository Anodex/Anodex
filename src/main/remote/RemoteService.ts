import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { collectHostAddresses, primaryHostAddress } from './addresses'
import { join } from 'node:path'
import type { RemoteInternetAccess, RemotePairingCode, RemoteStatus } from '@shared/remote.types'
import { MAPPING_LIFETIME_SECONDS, releasePortMapping, requestPortMapping } from './natpmp'
import QRCode from 'qrcode'
import { createLogger } from '../utils/logger'
import { fingerprintOf, generateRemoteCertificate, type RemoteCertificate } from './certificate'
import { PairingService, type PairedDevice, type PairedDeviceStore } from './pairing'
import { PROTOCOL_VERSION, RemoteBridge } from './RemoteBridge'

const log = createLogger('remote')

/**
 * The port to try first.
 *
 * Fixed rather than ephemeral, and that is the whole point: the phone stores the
 * address and port it paired on, so a port that changed every launch meant a
 * paired phone could never reconnect after the desktop restarted. It also meant
 * the number shown next to a pairing code went stale the moment Anodex reopened.
 */
const DEFAULT_PORT = 47800

interface PersistedState {
  /** Off by default, and stays off until the user turns it on (§7.1). */
  enabled: boolean
  /**
   * Whether the user has asked for this machine to be reachable from the internet.
   *
   * Separate from `enabled` on purpose. Turning the listener on exposes it to the
   * home network; this exposes it to everyone, and the two decisions deserve to be
   * made separately rather than bundled into one switch.
   */
  internetEnabled?: boolean
  /** A public address the user forwarded themselves, when automatic mapping cannot. */
  manualExternalAddress?: string
  manualExternalPort?: number
  /** The port actually in use, so it survives a restart. */
  port?: number
  certPem?: string
  /** safeStorage-encrypted, base64. Never written in the clear. */
  encryptedKeyPem?: string
  device?: PairedDevice
}

/**
 * Owns the remote listener: its lifetime, its identity, and what persists.
 *
 * The listener is **off by default** and nothing here starts it implicitly. That
 * is the first of §7's non-negotiables, and it is enforced by this class rather
 * than by whoever remembers to call `stop()`.
 *
 * The certificate is generated once and kept, because regenerating it silently
 * invalidates every existing pairing — the phone pins it, and a new one is
 * indistinguishable from an impostor. Its private key is encrypted at rest with
 * `safeStorage`, following `EmailAuthStore`: nothing secret is written in the
 * clear, and a copy of the settings directory is not an identity.
 */
export class RemoteService {
  private certificate: RemoteCertificate | null = null
  private internet: RemoteInternetAccess = {
    enabled: false,
    address: null,
    port: null,
    source: 'none',
    problem: null
  }
  private mappingRenewal: ReturnType<typeof setInterval> | null = null
  private bridge: RemoteBridge | null = null
  private state: PersistedState = { enabled: false }
  private readonly filePath: string
  private readonly pairing: PairingService

  constructor() {
    this.filePath = join(app.getPath('userData'), 'remote.json')

    const store: PairedDeviceStore = {
      read: () => this.state.device ?? null,
      write: (device) => {
        const changed = device?.deviceId !== this.state.device?.deviceId
        this.state.device = device ?? undefined
        this.persist()

        // A phone pairing is something the user is watching for on this screen, so
        // Settings has to hear about it. Without this the page only learned a phone
        // had paired when it was reopened — which looked exactly like pairing having
        // silently failed.
        if (changed) this.onStatusChanged?.(this.status())
      }
    }
    this.pairing = new PairingService(store)
  }

  /**
   * Called whenever the listener or the paired device changes, so Settings can
   * update live rather than on next open.
   */
  onStatusChanged: ((status: RemoteStatus) => void) | null = null

  /** Load persisted state and, if the user had it on, start listening again. */
  async initialize(): Promise<void> {
    this.load()
    if (this.state.enabled) {
      try {
        await this.start()
      } catch (error) {
        // A port already in use must not stop the app from launching. The user is
        // told through Settings rather than by Anodex failing to open.
        log.error('could not restore the remote listener:', error)
        this.state.enabled = false
        this.persist()
      }
    }
  }

  status(): RemoteStatus {
    const device = this.pairing.paired()
    return {
      listening: this.bridge?.listening ?? false,
      port: this.bridge?.port ?? null,
      address: primaryHostAddress(),
      addresses: collectHostAddresses(),
      hostName: hostname(),
      certificateSha256: this.certificate?.sha256 ?? '',
      protocolVersion: PROTOCOL_VERSION,
      pairedDevice: device
        ? {
            name: device.name,
            pairedAtEpochMs: device.pairedAtEpochMs,
            lastSeenEpochMs: device.lastSeenEpochMs
          }
        : null,
      internet: this.internet
    }
  }

  /**
   * Ask for, or give up, a route in from the internet.
   *
   * Tries the router first. Where that is refused - and it very often is, because
   * NAT-PMP and UPnP are off by default on a lot of routers - the user can forward
   * the port themselves and type the address in, which works everywhere and needs
   * nothing of anyone else's running.
   */
  async setInternetAccess(enabled: boolean): Promise<RemoteStatus> {
    this.state.internetEnabled = enabled
    this.persist()

    if (!enabled) {
      await this.releaseMapping()
      this.internet = { enabled: false, address: null, port: null, source: 'none', problem: null }
      return this.status()
    }

    await this.acquireInternetRoute()
    return this.status()
  }

  /**
   * Record a public address the user forwarded by hand.
   *
   * Trusted as given: only the router knows what it was configured to do, and a
   * wrong value costs a failed connection attempt rather than anything unsafe -
   * the pairing handshake is what decides who may talk, not the address.
   */
  async setManualExternalAddress(
    address: string | null,
    port: number | null
  ): Promise<RemoteStatus> {
    this.state.manualExternalAddress = address?.trim() || undefined
    this.state.manualExternalPort = port ?? undefined
    this.persist()

    if (this.state.internetEnabled) await this.acquireInternetRoute()
    return this.status()
  }

  private async acquireInternetRoute(): Promise<void> {
    const port = this.bridge?.port
    if (!port) {
      this.internet = {
        enabled: true,
        address: null,
        port: null,
        source: 'none',
        problem: 'Turn remote access on first.'
      }
      return
    }

    // A manually forwarded port wins. The user configured their own router, which
    // is better evidence than anything this can infer.
    if (this.state.manualExternalAddress) {
      this.internet = {
        enabled: true,
        address: this.state.manualExternalAddress,
        port: this.state.manualExternalPort ?? port,
        source: 'manual',
        problem: null
      }
      return
    }

    const result = await requestPortMapping(port)
    if (result.ok) {
      this.internet = {
        enabled: true,
        address: result.mapping.externalAddress,
        port: result.mapping.externalPort,
        source: 'automatic',
        problem: null
      }
      this.startMappingRenewal(port)
      log.info(`internet route: ${result.mapping.externalAddress}:${result.mapping.externalPort}`)
      return
    }

    this.internet = {
      enabled: true,
      address: null,
      port: null,
      source: 'none',
      problem: result.failure.message
    }
    log.warn('could not open a port automatically:', result.failure.reason)
  }

  /**
   * Keep the mapping alive while the listener runs.
   *
   * The lease is deliberately short so a crash leaves the router closing the hole
   * on its own, which means it has to be renewed - well before it expires, since a
   * renewal that lands late is a window in which the phone simply cannot connect.
   */
  private startMappingRenewal(port: number): void {
    this.stopMappingRenewal()
    const interval = setInterval(
      () => {
        void requestPortMapping(port)
      },
      (MAPPING_LIFETIME_SECONDS / 2) * 1000
    )
    interval.unref?.()
    this.mappingRenewal = interval
  }

  private stopMappingRenewal(): void {
    if (this.mappingRenewal) clearInterval(this.mappingRenewal)
    this.mappingRenewal = null
  }

  private async releaseMapping(): Promise<void> {
    this.stopMappingRenewal()
    const port = this.bridge?.port
    // Withdrawn rather than left to expire: a hole that outlives the program which
    // asked for it is what gives automatic port forwarding its bad name.
    if (port && this.internet.source === 'automatic') await releasePortMapping(port)
  }

  async setEnabled(enabled: boolean): Promise<RemoteStatus> {
    if (enabled) {
      await this.start()
      if (this.state.internetEnabled) await this.acquireInternetRoute()
    } else {
      await this.releaseMapping()
      this.internet = { enabled: false, address: null, port: null, source: 'none', problem: null }
      await this.stop()
    }

    this.state.enabled = enabled
    this.persist()
    return this.status()
  }

  /**
   * Open a pairing window and return everything the QR needs.
   *
   * The shape matches what the phone parses: `anodex://pair?v=…`. Built here so
   * the two sides cannot drift on field names without the phone's strict parser
   * rejecting it loudly.
   */
  async beginPairing(): Promise<RemotePairingCode | null> {
    if (!this.bridge?.listening || !this.certificate) return null

    const session = this.pairing.beginPairing()
    const params = new URLSearchParams({
      v: '1',
      h: this.deviceIdentity(),
      n: hostname(),
      a: primaryHostAddress() ?? '127.0.0.1',
      p: String(this.bridge.port ?? 0),
      f: Buffer.from(this.certificate.sha256, 'hex').toString('base64url'),
      s: session.secret,
      e: String(Math.floor(session.expiresAtEpochMs / 1000))
    })

    const uri = `anodex://pair?${params.toString()}`

    return {
      uri,
      fingerprint: this.certificate.sha256,
      // Rendered from `uri` itself, so what the phone scans and what the desktop
      // believes it showed cannot drift apart.
      qrDataUrl: await QRCode.toDataURL(uri, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 320,
        color: { dark: '#f0f0f0', light: '#111111' }
      }),
      shortCode: session.shortCode,
      address: primaryHostAddress() ?? '127.0.0.1',
      port: this.bridge.port ?? 0,
      expiresAtEpochMs: session.expiresAtEpochMs
    }
  }

  cancelPairing(): void {
    this.pairing.cancelPairing()
  }

  /** Revoke the paired phone. Its stored key stops working immediately. */
  revoke(): RemoteStatus {
    this.pairing.revoke()
    return this.status()
  }

  async shutdown(): Promise<void> {
    await this.releaseMapping()
    await this.stop()
  }

  /** The public address, if there is one, for the phone's address list. */
  externalAddress(): string | null {
    return this.internet.enabled ? this.internet.address : null
  }

  private async start(): Promise<void> {
    if (this.bridge?.listening) return

    const certificate = await this.ensureCertificate()
    const bridge = new RemoteBridge(this.pairing, certificate, undefined, () =>
      this.externalAddress()
    )

    // Prefer the port we used last time, so a paired phone finds us where it left
    // us. Falling back to an ephemeral one keeps a clash with some other program
    // from making remote access simply unavailable — the new port is persisted, and
    // the phone re-pairs, which is worse than seamless but better than broken.
    const preferred = this.state.port ?? DEFAULT_PORT
    let bound: number
    try {
      bound = await bridge.start(preferred)
    } catch (error) {
      log.warn(`port ${preferred} is unavailable, taking any free port:`, error)
      bound = await bridge.start(0)
    }

    if (this.state.port !== bound) {
      this.state.port = bound
      this.persist()
    }
    this.bridge = bridge
    log.info(`remote listener ready on 0.0.0.0:${bound}`)
  }

  private async stop(): Promise<void> {
    await this.bridge?.stop()
    this.bridge = null
  }

  private async ensureCertificate(): Promise<RemoteCertificate> {
    if (this.certificate) return this.certificate

    const keyPem = this.decrypt(this.state.encryptedKeyPem)
    if (this.state.certPem && keyPem) {
      this.certificate = {
        certPem: this.state.certPem,
        privateKeyPem: keyPem,
        sha256: fingerprintOf(this.state.certPem)
      }
      return this.certificate
    }

    log.info('generating a new remote identity — any previous pairing is now invalid')
    const created = await generateRemoteCertificate(`Anodex on ${hostname()}`)
    this.certificate = created
    this.state.certPem = created.certPem
    this.state.encryptedKeyPem = this.encrypt(created.privateKeyPem)
    this.persist()
    return created
  }

  /** Stable identity for this desktop, so pairing binds to the machine not its address. */
  private deviceIdentity(): string {
    return this.certificate?.sha256.slice(0, 16) ?? 'unknown'
  }

  private encrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this system.')
    }
    return safeStorage.encryptString(value).toString('base64')
  }

  private decrypt(value: string | undefined): string | null {
    if (!value || !safeStorage.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch (error) {
      log.warn('could not decrypt the remote private key:', error)
      return null
    }
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      this.state = JSON.parse(readFileSync(this.filePath, 'utf-8')) as PersistedState
    } catch (error) {
      log.warn('remote.json is unreadable; starting from a clean state:', error)
      this.state = { enabled: false }
    }
  }

  private persist(): void {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8')
    } catch (error) {
      log.error('could not save remote settings:', error)
    }
  }
}

export const remoteService = new RemoteService()
