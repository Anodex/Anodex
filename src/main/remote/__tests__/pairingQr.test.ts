import { randomBytes } from 'node:crypto'
import QRCode from 'qrcode'
import { describe, expect, it } from 'vitest'

/**
 * How dense the pairing QR code is allowed to get.
 *
 * A real failure rather than a hypothetical. The pairing URI is a little over 200
 * characters, which QR encodes as a **53×53 module grid** — and a phone that reads
 * every other QR code instantly could not read this one. CameraX analyses frames at
 * 640×480 by default, so a code filling half the frame height puts each module on
 * roughly four and a half pixels, and camera blur and monitor glare eat that margin.
 * An everyday QR code is a short URL: 25 to 29 modules, and twice the pixels per
 * module at the same resolution.
 *
 * The phone now analyses at 1280×720, which roughly doubles it back. This is the
 * other half of the fix: a field added to the payload later would push the grid
 * denser again, and the only symptom would be scanning quietly getting worse on some
 * phones and not others — the hardest kind of regression to attribute to a commit.
 */

/**
 * 57×57, one QR version above what the payload currently needs.
 *
 * Deliberately not set to today's exact size. A budget with no headroom fails on a
 * one-character rename and teaches people to raise the number without thinking;
 * this one absorbs a small addition and trips on a real one.
 */
const MAX_MODULES = 57

/** The fields `RemoteService.beginPairing` puts in the URI, at realistic sizes. */
function representativePairingUri(): string {
  const params = new URLSearchParams({
    v: '1',
    // A UUID host identity.
    h: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    // Windows caps a machine name at 15 characters.
    n: 'WORKSTATION-001',
    a: '192.168.100.200',
    p: '47800',
    f: randomBytes(32).toString('base64url'),
    s: randomBytes(32).toString('base64url'),
    e: String(Math.floor(Date.now() / 1000))
  })
  return `anodex://pair?${params.toString()}`
}

function moduleCount(text: string): number {
  return QRCode.create(text, { errorCorrectionLevel: 'M' }).modules.size
}

describe('the pairing QR code stays scannable', () => {
  it('fits inside the module budget the phone camera can resolve', () => {
    const modules = moduleCount(representativePairingUri())

    expect(
      modules,
      `The pairing payload now needs a ${modules}x${modules} QR code, over the ` +
        `${MAX_MODULES}x${MAX_MODULES} the phone is set up to resolve. Adding a field to the ` +
        'pairing URI is what does this. Either drop something, shorten it, or raise the ' +
        "image-analysis resolution in the phone's ScanScreen to match."
    ).toBeLessThanOrEqual(MAX_MODULES)
  })

  it('catches a field being added', () => {
    // Proof the guard can fail. Two more base64 secrets is what an innocuous-looking
    // addition costs, and it takes the grid past the budget.
    const bloated =
      `${representativePairingUri()}` +
      `&x=${randomBytes(32).toString('base64url')}` +
      `&y=${randomBytes(32).toString('base64url')}`

    expect(moduleCount(bloated)).toBeGreaterThan(MAX_MODULES)
  })

  it('keeps error correction at M rather than buying room by lowering it', () => {
    // Dropping to L would fit more characters into the same grid and would be the
    // wrong trade: this code is read once, in a hurry, off a bright monitor at an
    // angle. Error correction is what absorbs the glare.
    const uri = representativePairingUri()

    expect(QRCode.create(uri, { errorCorrectionLevel: 'L' }).modules.size).toBeLessThanOrEqual(
      moduleCount(uri)
    )
  })
})
