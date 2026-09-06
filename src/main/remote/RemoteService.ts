import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { createLogger } from '../utils/logger'
import { generateRemoteCertificate, type RemoteCertificate } from './certificate'
import { PairingService, type PairedDevice, type PairedDeviceStore } from './pairing'
import { PROTOCOL_VERSION, RemoteBridge } from './RemoteBridge'

const log = createLogger('remote')

/** What Settings shows and the QR encodes. */
export interface RemoteStatus {
  listening: boolean
  port: number | null
  /** LAN address a phone should try first, or null if none could be determined. */
  address: string | null
  hostName: string
  certificateSha256: string
  protocolVersion: string
  pairedDevice: { name: string; pairedAtEpochMs: number; lastSeenEpochMs: number } | null
}

interface PersistedState {
  /** Off by default, and stays off until the user turns it on (§7.1). */
  enabled: boolean
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
  private bridge: RemoteBridge | null = null
  private state: PersistedState = { enabled: false }
  private readonly filePath: string
  private readonly pairing: PairingService

  constructor() {
    this.filePath = join(app.getPath('userData'), 'remote.json')

    const store: PairedDeviceStore = {
      read: () => this.state.device ?? null,
      write: (device) => {
        this.state.device = device ?? undefined
        this.persist()
      }
    }
    this.pairing = new PairingService(store)
  }

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
      address: lanAddress(),
      hostName: hostname(),
      certificateSha256: this.certificate?.sha256 ?? '',
      protocolVersion: PROTOCOL_VERSION,
      pairedDevice: device
        ? {
            name: device.name,
            pairedAtEpochMs: device.pairedAtEpochMs,
            lastSeenEpochMs: device.lastSeenEpochMs
          }
        : null
    }
  }

  async setEnabled(enabled: boolean): Promise<RemoteStatus> {
    if (enabled) await this.start()
    else await this.stop()

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
  beginPairing(): { uri: string; fingerprint: string; expiresAtEpochMs: number } | null {
    if (!this.bridge?.listening || !this.certificate) return null

    const session = this.pairing.beginPairing()
    const params = new URLSearchParams({
      v: '1',
      h: this.deviceIdentity(),
      n: hostname(),
      a: lanAddress() ?? '127.0.0.1',
      p: String(this.bridge.port ?? 0),
      f: Buffer.from(this.certificate.sha256, 'hex').toString('base64url'),
      s: session.secret,
      e: String(Math.floor(session.expiresAtEpochMs / 1000))
    })

    return {
      uri: `anodex://pair?${params.toString()}`,
      fingerprint: this.certificate.sha256,
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
    await this.stop()
  }

  private async start(): Promise<void> {
    if (this.bridge?.listening) return

    const certificate = await this.ensureCertificate()
    const bridge = new RemoteBridge(this.pairing, certificate)
    await bridge.start(0)
    this.bridge = bridge
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
        sha256: (await import('./certificate')).fingerprintOf(this.state.certPem)
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

/**
 * The first non-internal IPv4 address, which is what a phone on the same Wi-Fi
 * should try.
 *
 * Best-effort by nature: a machine with several interfaces has no single right
 * answer, and the phone treats the address as a hint anyway — pairing binds to
 * the host's identity, not to this (§10.1), so a wrong guess costs a retry
 * rather than a broken pairing.
 */
function lanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return null
}

export const remoteService = new RemoteService()
