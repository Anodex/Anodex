import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RELEASE_PUBLIC_KEY_PEM } from '../releaseKey'
import { sha512OfFile, signatureUrlFor, verifyUpdateFile } from '../verifyRelease'

/**
 * The question these answer is narrow and worth stating: can anything other
 * than the real release key produce an installer this app will run?
 *
 * So the interesting cases are the refusals, and one of them — a tampered
 * installer re-signed with a key the attacker controls — is the whole reason
 * the signature exists rather than trusting the sha512 in `latest.yml`.
 */

const release = generateKeyPairSync('ed25519')
const attacker = generateKeyPairSync('ed25519')

const publicKeyPem = release.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const attackerPublicKeyPem = attacker.publicKey.export({ type: 'spki', format: 'pem' }).toString()

let dir: string
let installer: string
let digestBase64: string
let goodSignature: string

const ASSET = 'Anodex-Setup-0.2.2.exe'

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'anodex-verify-'))
  installer = join(dir, ASSET)
  writeFileSync(installer, 'pretend this is three hundred megabytes of installer')

  const digest = await sha512OfFile(installer)
  digestBase64 = digest.toString('base64')
  goodSignature = sign(null, digest, release.privateKey).toString('base64')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** The release metadata as `latest.yml` would describe this installer. */
const files = () => [{ url: ASSET, sha512: digestBase64 }]

/** Asserts a refusal and hands back the reason, properly typed. */
const rejectionReason = async (
  overrides: Partial<Parameters<typeof verifyUpdateFile>[0]> = {}
): Promise<string> => {
  const result = await verify(overrides)
  expect(result.verdict).toBe('rejected')
  return result.verdict === 'rejected' ? result.reason : ''
}

const verify = (overrides: Partial<Parameters<typeof verifyUpdateFile>[0]> = {}) =>
  verifyUpdateFile({
    downloadedFile: installer,
    version: '0.2.2',
    files: files(),
    publicKeyPem,
    fetchSignature: () => Promise.resolve(goodSignature),
    ...overrides
  })

describe('verifyUpdateFile', () => {
  it('accepts an installer signed by the release key', async () => {
    await expect(verify()).resolves.toEqual({ verdict: 'verified' })
  })

  it('refuses an installer whose signature is from another key', async () => {
    const digest = await sha512OfFile(installer)
    const forged = sign(null, digest, attacker.privateKey).toString('base64')

    await expect(verify({ fetchSignature: () => Promise.resolve(forged) })).resolves.toMatchObject({
      verdict: 'rejected'
    })
  })

  it('refuses a build whose baked-in key is not the one that signed', async () => {
    await expect(verify({ publicKeyPem: attackerPublicKeyPem })).resolves.toMatchObject({
      verdict: 'rejected'
    })
  })

  it('refuses an installer that matches no hash in the release metadata', async () => {
    const tampered = join(dir, 'tampered.exe')
    writeFileSync(tampered, 'not the installer that was signed')

    expect(await rejectionReason({ downloadedFile: tampered })).toContain('no hash')
  })

  // Fail-open would be worthless: whoever can replace the installer can delete
  // the signature beside it, so "no signature" has to mean "do not install".
  it('refuses a release that carries no signature', async () => {
    expect(await rejectionReason({ fetchSignature: () => Promise.resolve(null) })).toContain(
      'no signature'
    )
  })

  it('refuses when the signature cannot be fetched at all', async () => {
    await expect(
      verify({
        fetchSignature: () => Promise.reject(new Error('offline'))
      })
    ).resolves.toMatchObject({ verdict: 'rejected' })
  })

  it('refuses a malformed signature rather than throwing', async () => {
    await expect(
      verify({ fetchSignature: () => Promise.resolve('not base64 at all!!') })
    ).resolves.toMatchObject({ verdict: 'rejected' })
  })

  // A build compiled before the key was provisioned reports that plainly
  // rather than claiming a guarantee it cannot make.
  it('reports an unenforced check when no key is compiled in', async () => {
    await expect(verify({ publicKeyPem: null })).resolves.toMatchObject({ verdict: 'unenforced' })
  })
})

describe('signatureUrlFor', () => {
  it('points at the asset beside the installer in the same release', () => {
    expect(signatureUrlFor('0.2.2', ASSET)).toBe(
      `https://github.com/Anodex/Anodex/releases/download/v0.2.2/${ASSET}.sig`
    )
  })

  // `UpdateFileInfo.url` is whatever `latest.yml` says. Taking the last segment
  // keeps a path there from redirecting this request somewhere else.
  it('uses only the last path segment', () => {
    expect(signatureUrlFor('0.2.2', `https://elsewhere.example/${ASSET}`)).toBe(
      `https://github.com/Anodex/Anodex/releases/download/v0.2.2/${ASSET}.sig`
    )
  })
})

describe('the shipped release key', () => {
  // The whole chain is inert without this, and inert looks exactly like working
  // — updates download and install, they are simply never checked. Nothing else
  // in the suite would notice, because every other test supplies its own key.
  it('is compiled into the build', () => {
    expect(RELEASE_PUBLIC_KEY_PEM).not.toBeNull()
  })

  it('is a usable Ed25519 public key', () => {
    const key = createPublicKey(RELEASE_PUBLIC_KEY_PEM as string)
    expect(key.asymmetricKeyType).toBe('ed25519')
    expect(key.type).toBe('public')
  })
})
