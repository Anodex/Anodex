#!/usr/bin/env node
// Generates the Anodex release-signing keypair.
//
// Run this once, on the machine that cuts releases, and never again — a second
// run mints a key that every already-installed copy of Anodex will reject,
// because the public half they carry was baked in at build time. That is the
// point of the design (see src/main/updates/releaseKey.ts) and also its one
// sharp edge: losing the private key means shipping a build with a new public
// key before anyone can update past it.
//
//   node scripts/generate-release-key.mjs ~/.anodex/release-signing-key.pem
//
// Keep the output OUTSIDE the repository. If it ever lives in the repo, in CI
// secrets, or anywhere a release-write token can reach, the signature stops
// proving anything the sha512 did not already prove.
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const target = process.argv[2]

if (!target) {
  console.error('usage: node scripts/generate-release-key.mjs <path-to-private-key.pem>')
  process.exit(1)
}

const path = resolve(target)

// Refuse rather than overwrite. Silently replacing a signing key is the one
// mistake here with no recovery path for anybody already running Anodex.
if (existsSync(path)) {
  console.error(`refusing to overwrite an existing key at ${path}`)
  console.error('if you genuinely mean to rotate, move the old key aside first')
  process.exit(1)
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')

mkdirSync(dirname(path), { recursive: true })
// 0600 is advisory on Windows, where the ACL inherited from the parent
// directory is what actually governs access — hence the reminder to keep this
// somewhere already private, rather than trusting the mode bits.
writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })

console.log(`private key written to ${path}`)
console.log('back it up somewhere offline; it cannot be recovered\n')
console.log('paste this into src/main/updates/releaseKey.ts:\n')
console.log('export const RELEASE_PUBLIC_KEY_PEM: string | null = `')
console.log(publicKey.export({ type: 'spki', format: 'pem' }).toString().trim())
console.log('`')
