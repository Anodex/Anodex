import { describe, expect, it } from 'vitest'
import { X509Certificate } from 'node:crypto'
import { fingerprintOf, generateRemoteCertificate } from '../certificate'

/**
 * The certificate the phone pins.
 *
 * The derivation has to match the phone's exactly, because a mismatch produces a
 * pin nothing can ever satisfy and the symptom — every connection refused — looks
 * nothing like its cause.
 */
describe('remote certificate', () => {
  it('produces a usable self-signed certificate and key', async () => {
    const cert = await generateRemoteCertificate()

    expect(cert.certPem).toContain('BEGIN CERTIFICATE')
    expect(cert.privateKeyPem).toContain('PRIVATE KEY')
    expect(new X509Certificate(cert.certPem).subject).toContain('Anodex')
  })

  it('fingerprints the DER bytes, which is what the phone hashes', async () => {
    const cert = await generateRemoteCertificate()

    // Cross-checked against Node's own fingerprint256 rather than against a second
    // copy of my arithmetic. Recomputing it the same way would agree with itself
    // even if the derivation were wrong; the phone computes the standard one.
    const canonical = new X509Certificate(cert.certPem).fingerprint256
      .replace(/:/g, '')
      .toLowerCase()

    expect(cert.sha256).toBe(canonical)
    expect(cert.sha256).toHaveLength(64)
    expect(fingerprintOf(cert.certPem)).toBe(cert.sha256)
  })

  it('gives a different identity every time it is generated', async () => {
    // Which is exactly why the caller must persist one rather than regenerate:
    // a new certificate silently invalidates every existing pairing.
    const [first, second] = await Promise.all([
      generateRemoteCertificate(),
      generateRemoteCertificate()
    ])

    expect(first.sha256).not.toBe(second.sha256)
  })
})
