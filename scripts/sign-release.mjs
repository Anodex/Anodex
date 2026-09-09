#!/usr/bin/env node
// Signs release installers with the Anodex release key, writing `<file>.sig`
// beside each one.
//
//   node scripts/sign-release.mjs --key ~/.anodex/release-signing-key.pem dist/*.exe dist/*.dmg dist/*.AppImage
//
// This runs on the release machine, against installers downloaded from the
// draft release — not in CI. CI never sees the key, which is the entire reason
// a signature says more here than the sha512 in `latest.yml` does: that hash
// travels with the installer and anyone who can replace one can replace both.
//
// What is signed is the installer's raw SHA-512 digest, matching
// src/main/updates/verifyRelease.ts byte for byte. Signing the digest rather
// than the file keeps a 300 MB installer out of memory on both sides.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { RELEASE_KEY_SOURCE, pem, shippedPublicKey } from './release-key-source.mjs'
import { createReadStream, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const keyIndex = args.indexOf('--key')

if (keyIndex === -1 || !args[keyIndex + 1]) {
  console.error('usage: node scripts/sign-release.mjs --key <private-key.pem> <file>...')
  process.exit(1)
}

const keyPath = args[keyIndex + 1]
const files = args.filter((_, i) => i !== keyIndex && i !== keyIndex + 1)

if (files.length === 0) {
  console.error('no files to sign')
  process.exit(1)
}

const privateKey = createPrivateKey(readFileSync(keyPath))

// Checked against the key the app actually carries, not the one derived from
// what we just signed with. Deriving it would only prove the signature is
// self-consistent — true of any key, including the wrong one.
const shipped = shippedPublicKey()

if (!shipped) {
  console.error(`No release key compiled into ${RELEASE_KEY_SOURCE}.`)
  console.error('Builds from this tree cannot verify an update. Run: npm run release:keygen')
  process.exit(1)
}

if (pem(createPublicKey(privateKey)) !== pem(shipped)) {
  console.error(`The key at ${keyPath} is not the key compiled into ${RELEASE_KEY_SOURCE}.`)
  console.error('Signing with it would produce a release every install refuses.')
  process.exit(1)
}

const publicKey = shipped

function sha512(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest()))
  })
}

let failed = false

for (const file of files) {
  const digest = await sha512(file)
  // Ed25519 signs the message itself; `null` is how node:crypto spells "the
  // curve already defines the hash".
  const signature = sign(null, digest, privateKey)

  // Verify before writing. A signature that does not check out against its own
  // key means something is wrong with the key material or this build of Node,
  // and the moment to find that out is now — not when an installed copy of
  // Anodex refuses a release nobody can replace.
  if (!verify(null, digest, publicKey, signature)) {
    console.error(`FAILED self-check: ${file}`)
    failed = true
    continue
  }

  writeFileSync(`${file}.sig`, `${signature.toString('base64')}\n`)
  console.log(`signed ${file}`)
  console.log(`  sha512 ${digest.toString('base64')}`)
}

if (failed) process.exit(1)

console.log('\nupload every .sig to the draft release, then publish it')
