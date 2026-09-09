import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { UpdateFileInfo } from 'electron-updater'
import { RELEASE_PUBLIC_KEY_PEM } from './releaseKey'

/**
 * Decides whether a downloaded installer is one Anodex published.
 *
 * The check is a detached Ed25519 signature over the installer's SHA-512
 * digest, published beside the installer as `<asset>.sig` and verified against
 * the key baked into this build. See `releaseKey.ts` for why the signature —
 * not the sha512 in `latest.yml` — is the part that resists substitution.
 *
 * Everything here is pure apart from the injected `fetchSignature`, so the
 * decision can be tested without a network or a real release.
 */

/** Anodex/Anodex is public; release assets are served from a stable path. */
const RELEASE_ASSET_BASE = 'https://github.com/Anodex/Anodex/releases/download'

const SIGNATURE_TIMEOUT_MS = 30_000

export type ReleaseVerdict =
  /** Signed by the release key. Safe to install. */
  | { verdict: 'verified' }
  /** This build predates the signing key, so there is nothing to check against. */
  | { verdict: 'unenforced'; reason: string }
  /** Actively failed. The installer must not run. */
  | { verdict: 'rejected'; reason: string }

/** SHA-512 of a file, streamed so a 300 MB installer never lands in memory. */
export function sha512OfFile(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest()))
  })
}

/**
 * Verifies a detached Ed25519 signature over `digest`.
 *
 * Ed25519 signs the message directly — hence the `null` algorithm, which is how
 * `node:crypto` spells "the curve already defines the hash". `digest` is the
 * raw 64 bytes from `sha512OfFile`, not its base64 spelling, so the bytes
 * signed at release time and the bytes checked here cannot drift apart on an
 * encoding detail.
 */
export function verifyDigestSignature(
  digest: Buffer,
  signatureBase64: string,
  publicKeyPem: string
): boolean {
  try {
    const key = createPublicKey(publicKeyPem)
    return verify(null, digest, key, Buffer.from(signatureBase64.trim(), 'base64'))
  } catch {
    // A malformed key or signature is a failed verification, not a crash:
    // whatever produced it, this installer has not been shown to be genuine.
    return false
  }
}

/** The `<asset>.sig` URL for a release file, given the version it belongs to. */
export function signatureUrlFor(version: string, fileUrl: string): string {
  // `UpdateFileInfo.url` is the asset name as `latest.yml` spells it, which may
  // be percent-encoded. Take the last segment so a future nested path cannot
  // send this request somewhere else.
  const asset = fileUrl.split('/').pop() ?? fileUrl
  return `${RELEASE_ASSET_BASE}/v${version}/${asset}.sig`
}

/** Fetches a detached signature. Returns null when there isn't one. */
export async function fetchSignature(url: string): Promise<string | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(SIGNATURE_TIMEOUT_MS) })
  if (!response.ok) return null
  return (await response.text()).trim()
}

export interface VerifyUpdateInput {
  /** Path electron-updater downloaded to. */
  downloadedFile: string
  version: string
  /** `files` from the update metadata — the asset names and their hashes. */
  files: UpdateFileInfo[]
  fetchSignature?: (url: string) => Promise<string | null>
  /** Omit to use the build's key; pass `null` to check as an unkeyed build would. */
  publicKeyPem?: string | null
}

/**
 * The whole decision, fail-closed.
 *
 * A missing or unreadable signature is a rejection, not a pass. Fail-open would
 * be worthless here: an attacker who can replace the installer can equally
 * delete the `.sig` beside it, so treating "no signature" as "fine" would hand
 * back exactly the guarantee this is meant to provide.
 *
 * The one deliberate exception is a build with no key compiled in, which is
 * reported as `unenforced` rather than silently passing, so the caller can say
 * out loud that nothing was verified.
 */
export async function verifyUpdateFile(input: VerifyUpdateInput): Promise<ReleaseVerdict> {
  // `undefined` means "not supplied, use the build's key"; an explicit `null`
  // means "there is no key". Collapsing the two with `??` made it impossible to
  // ask for an unkeyed check once a real key was compiled in.
  const publicKeyPem =
    input.publicKeyPem === undefined ? RELEASE_PUBLIC_KEY_PEM : input.publicKeyPem
  if (!publicKeyPem) {
    return {
      verdict: 'unenforced',
      reason: 'this build has no release signing key compiled in'
    }
  }

  const digest = await sha512OfFile(input.downloadedFile)
  const digestBase64 = digest.toString('base64')

  // Identifying the asset by its hash rather than by filename does two jobs at
  // once: it says which `.sig` to ask for, and it confirms the bytes on disk are
  // the bytes the release metadata describes. A file matching no declared hash
  // is already wrong, whatever a signature might later say about it.
  const file = input.files.find((candidate) => candidate.sha512 === digestBase64)
  if (!file) {
    return {
      verdict: 'rejected',
      reason: 'the downloaded file matches no hash in the release metadata'
    }
  }

  const url = signatureUrlFor(input.version, file.url)
  const fetcher = input.fetchSignature ?? fetchSignature

  let signature: string | null
  try {
    signature = await fetcher(url)
  } catch (error) {
    return {
      verdict: 'rejected',
      reason: `the release signature could not be fetched: ${(error as Error).message}`
    }
  }

  if (!signature) {
    return { verdict: 'rejected', reason: 'this release carries no signature' }
  }

  if (!verifyDigestSignature(digest, signature, publicKeyPem)) {
    return { verdict: 'rejected', reason: 'the release signature is not valid for this file' }
  }

  return { verdict: 'verified' }
}
