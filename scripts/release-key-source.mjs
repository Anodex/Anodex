// Reads the public key that ships inside the app, out of its own source.
//
// Both signing paths check against this rather than against the key they just
// signed with, because the failure worth catching is the two drifting apart:
// sign with a rotated key, forget to ship its public half, and every install
// refuses the update with no way back except another release.
import { createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const RELEASE_KEY_SOURCE = 'src/main/updates/releaseKey.ts'

/** The key compiled into the app, or null if this tree has none. */
export function shippedPublicKey() {
  const source = readFileSync(RELEASE_KEY_SOURCE, 'utf-8')
  const match = /RELEASE_PUBLIC_KEY_PEM: string \| null = `([^`]+)`/.exec(source)
  return match ? createPublicKey(match[1].trim()) : null
}

/** Same key in its canonical text form, for comparing two keys for equality. */
export const pem = (key) => key.export({ type: 'spki', format: 'pem' }).toString().trim()
