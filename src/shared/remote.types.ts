/**
 * The remote-access surface, shared between the desktop UI and the main process.
 *
 * Kept in `src/shared` like every other contract so the protocol generator picks
 * it up: the phone is built against the generated artifact, and a type that lives
 * outside this directory would be invisible to it.
 */

export interface RemotePairedDevice {
  name: string
  pairedAtEpochMs: number
  lastSeenEpochMs: number
}

export interface RemoteStatus {
  /** Whether a listener is currently accepting connections. Off by default. */
  listening: boolean
  port: number | null
  /** Best-effort LAN address for the QR. The phone pairs to identity, not this. */
  address: string | null
  hostName: string
  /** SHA-256 of the certificate the phone pins, lowercase hex. */
  certificateSha256: string
  protocolVersion: string
  pairedDevice: RemotePairedDevice | null
}

export interface RemotePairingCode {
  /** `anodex://pair?…` — rendered as the QR the phone scans. */
  uri: string
  /** Full fingerprint, shown on screen so the user can compare it with the phone. */
  fingerprint: string
  /** The QR as a data: URL, rendered in the main process from `uri` itself. */
  qrDataUrl: string
  /**
   * A short code for typing in when the camera cannot be used.
   *
   * Low-entropy on purpose and safe because of the two-minute window and the
   * five-attempt lockout, not because of its length.
   */
  shortCode: string
  /** Where to reach this machine, for the manual path. */
  address: string
  port: number
  expiresAtEpochMs: number
}
