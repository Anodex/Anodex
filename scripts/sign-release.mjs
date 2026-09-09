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
import { createReadStream, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const keyIndex = args.indexOf('--key')

const manifestIndex = args.indexOf('--manifest')

if (keyIndex === -1 || !args[keyIndex + 1]) {
  console.error('usage: node scripts/sign-release.mjs --key <private-key.pem> <file>...')
  console.error(
    '       node scripts/sign-release.mjs --key <private-key.pem> --manifest <dist dir>'
  )
  process.exit(1)
}

const keyPath = args[keyIndex + 1]
const consumed = new Set([keyIndex, keyIndex + 1, manifestIndex, manifestIndex + 1])
const positional = args.filter((arg, i) => !consumed.has(i) && !arg.startsWith('--'))

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

/**
 * The signature has to be named whatever the updater will ask for, and that is
 * not the local filename.
 *
 * electron-builder writes `Anodex Setup 0.3.0.exe` on disk but publishes it as
 * `Anodex-Setup-0.3.0.exe`, which is the name that lands in `latest.yml` and so
 * the name the app builds its `.sig` URL from. Uploading `<local name>.sig`
 * produced `Anodex.Setup.0.3.0.exe.sig` — GitHub turns spaces into dots — and
 * the updater asked for a file that did not exist. Every update would have been
 * refused, on a release that looked perfect.
 *
 * So the names come from the metadata, and each local file is matched to its
 * entry by hash rather than by filename. That also drops anything the release
 * does not declare, such as the branded installer shell sitting in `dist/`.
 */
async function fromManifest(dir) {
  const declared = []
  for (const name of readdirSync(dir).filter((f) => /^latest.*\.yml$/.test(f))) {
    const text = readFileSync(join(dir, name), 'utf-8')
    // Line-based rather than one multiline regex: `latest.yml` puts `sha512`
    // directly under its `url`, and reading them as a pair is easier to be sure
    // about than a pattern spanning line endings that differ per platform.
    const rows = text.split('\n')
    for (let i = 0; i < rows.length; i += 1) {
      const url = /^\s*-\s*url:\s*(.+?)\s*$/.exec(rows[i])
      if (!url) continue
      const hash = /^\s*sha512:\s*(.+?)\s*$/.exec(rows[i + 1] ?? '')
      if (hash) declared.push({ url: url[1].replace(/^['"]|['"]$/g, ''), sha512: hash[1] })
    }
  }

  if (declared.length === 0) {
    console.error(
      `No latest*.yml in ${dir}, so there is nothing saying what this release contains.`
    )
    process.exit(1)
  }

  const resolved = []
  for (const file of readdirSync(dir)) {
    if (/\.(yml|sig|blockmap)$/.test(file)) continue
    const digest = (await sha512(join(dir, file))).toString('base64')
    const entry = declared.find((candidate) => candidate.sha512 === digest)
    if (entry) resolved.push({ path: join(dir, file), sigName: join(dir, `${entry.url}.sig`) })
  }

  const missing = declared.filter((d) => !resolved.some((r) => r.sigName.endsWith(`${d.url}.sig`)))
  if (missing.length > 0) {
    console.error(`Declared in the metadata but not found in ${dir}:`)
    for (const entry of missing) console.error(`  ${entry.url}`)
    process.exit(1)
  }

  return resolved
}

const targets =
  manifestIndex === -1
    ? positional.map((file) => ({ path: file, sigName: `${file}.sig` }))
    : await fromManifest(args[manifestIndex + 1])

if (targets.length === 0) {
  console.error('no files to sign')
  process.exit(1)
}

let failed = false

for (const { path: file, sigName } of targets) {
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

  writeFileSync(sigName, `${signature.toString('base64')}\n`)
  console.log(`signed ${file}`)
  console.log(`  -> ${sigName}`)
}

if (failed) process.exit(1)

console.log('\nupload every .sig to the draft release, then publish it')
