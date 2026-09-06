import { createHash, X509Certificate } from 'node:crypto'
import selfsigned from 'selfsigned'

/**
 * The desktop's TLS identity for remote connections.
 *
 * No certificate authority can vouch for `192.168.1.42`, so there is no real
 * certificate to obtain and chain validation has nothing to validate against.
 * The phone pins this certificate at pairing instead and refuses anything else
 * afterwards, which is a *stronger* guarantee than the public PKI gives — it
 * ties the connection to one specific machine rather than to whoever can
 * persuade a CA.
 *
 * The consequence, which must be surfaced rather than left as a mystery:
 * regenerating this certificate invalidates every existing pairing. So it is
 * generated once, persisted, and reused — never rebuilt on a whim.
 */
export interface RemoteCertificate {
  /** PEM, for the TLS server. */
  readonly certPem: string
  /** PEM. Secret: never logged, never sent, never leaves this machine. */
  readonly privateKeyPem: string
  /**
   * SHA-256 over the certificate's DER encoding, lowercase hex.
   *
   * This exact value goes in the pairing QR and is what the phone pins, so the
   * derivation has to match the phone's byte for byte. DER, not PEM: PEM is a
   * base64 wrapper whose whitespace and headers are not part of the certificate.
   */
  readonly sha256: string
}

/** Anodex's certificates are long-lived because re-pairing is the cost of rotation. */
const VALIDITY_DAYS = 3650
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Create a fresh self-signed certificate.
 *
 * Callers should persist the result rather than calling this per launch — see
 * the note above about invalidating pairings.
 */
export async function generateRemoteCertificate(commonName = 'Anodex'): Promise<RemoteCertificate> {
  const notBeforeDate = new Date()
  const notAfterDate = new Date(notBeforeDate.getTime() + VALIDITY_DAYS * DAY_MS)

  const pems = await selfsigned.generate([{ name: 'commonName', value: commonName }], {
    notBeforeDate,
    notAfterDate,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      // A leaf, not an authority. It signs nothing but itself, and claiming cA
      // would assert a power it should not have even though pinning makes the
      // claim moot.
      { name: 'basicConstraints', cA: false },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true
      },
      { name: 'extKeyUsage', serverAuth: true },
      {
        // The address is not known in advance and changes between Wi-Fi and
        // Tailscale, so no SAN can be authoritative. This is why pairing binds to
        // the certificate rather than to a name: the pin is the identity, and the
        // hostname is not being asserted.
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' }
        ]
      }
    ]
  })

  return {
    certPem: pems.cert,
    privateKeyPem: pems.private,
    sha256: fingerprintOf(pems.cert)
  }
}

/**
 * SHA-256 of a PEM certificate's DER bytes, lowercase hex.
 *
 * Exported so the pairing QR, the Settings display and any diagnostic all derive
 * the fingerprint the same way. Two derivations that disagree would produce a
 * pin the phone can never match, and the symptom — every connection refused —
 * looks nothing like its cause.
 */
export function fingerprintOf(certPem: string): string {
  return createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex')
}
