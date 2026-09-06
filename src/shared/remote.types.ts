/**
 * The remote-access surface, shared between the desktop UI and the main process.
 *
 * Kept in `src/shared` like every other contract so the protocol generator picks
 * it up: the phone is built against the generated artifact, and a type that lives
 * outside this directory would be invisible to it.
 */

/**
 * Why the phone is being told something.
 *
 * Separate kinds because they deserve separate Android notification channels: a
 * run blocked on approval is time-sensitive and should be loud, while a run
 * finishing is not. One channel for both means the user either silences
 * everything or gets woken by a completion at 2am (§6.2).
 */
export type RemoteNotificationKind =
  /** Something is waiting on a human. The highest-value thing the phone can say. */
  | 'needs-approval'
  /** A run, task or reply finished. */
  | 'finished'
  /** A run failed or exhausted its budget. */
  | 'failed'

export interface RemoteNotification {
  kind: RemoteNotificationKind
  title: string
  /** Deliberately thin — this renders on a lock screen. */
  body: string
  /** Tapping the notification opens this conversation. */
  conversationId?: string
  atEpochMs: number
}

export interface RemoteHostAddress {
  address: string
  /** 'lan' works at home and is fastest; 'mesh' works anywhere; 'virtual' rarely works. */
  kind: 'lan' | 'mesh' | 'virtual'
  label: string
}

export interface RemotePairedDevice {
  name: string
  pairedAtEpochMs: number
  lastSeenEpochMs: number
}

export interface RemoteStatus {
  /** Whether a listener is currently accepting connections. Off by default. */
  listening: boolean
  port: number | null
  /** Best address for the QR. The phone pairs to identity, not to this. */
  address: string | null
  /**
   * Every address this machine can be reached at, best first.
   *
   * Shown in Settings so a user setting up a mesh VPN can see that Anodex has
   * noticed it, and sent to the phone so it can try each in turn when away.
   */
  addresses: RemoteHostAddress[]
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
