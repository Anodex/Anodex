#!/usr/bin/env node
// Signs a draft release and publishes it, in one command.
//
//   npm run release:finish -- v0.2.2
//
// CI packages the three installers into a draft. A draft is invisible to
// electron-updater, so nothing is offered to anybody until this finishes — that
// invisibility is the whole reason the signing window is safe. This is what
// closes it: download, sign, upload, check, publish.
//
// The private key is read from a file on this machine and never leaves it. That
// is the property worth protecting: the sha512 in `latest.yml` travels with the
// installer, so anyone who can write to a release can replace both. A signature
// made by a key CI has never seen is what makes that substitution fail.
import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, createPrivateKey, sign, verify } from 'node:crypto'
import { RELEASE_KEY_SOURCE, pem, shippedPublicKey } from './release-key-source.mjs'
import { createReadStream, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const tag = args.find((a) => !a.startsWith('--'))
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

if (!tag) {
  console.error('usage: npm run release:finish -- <tag> [--key <path>] [--dir <path>]')
  process.exit(1)
}

const keyPath = flag('key', join(homedir(), '.anodex', 'release-signing-key.pem'))
const dir = flag('dir', join('dist', 'release', tag))

const gh = (...a) => execFileSync('gh', a, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })

// The key the installed app will judge this release with.
const SOURCE = RELEASE_KEY_SOURCE
const shippedKey = shippedPublicKey()

if (!shippedKey) {
  console.error(`No release key compiled into ${SOURCE}.`)
  console.error('Builds from this tree cannot verify an update. Run: npm run release:keygen')
  process.exit(1)
}
let privateKey
try {
  privateKey = createPrivateKey(readFileSync(keyPath))
} catch (error) {
  console.error(`Cannot read the signing key at ${keyPath}: ${error.code ?? error.message}`)
  console.error('Pass --key <path>, or generate one with: npm run release:keygen')
  process.exit(1)
}

if (pem(createPublicKey(privateKey)) !== pem(shippedKey)) {
  console.error(`The key at ${keyPath} is not the key compiled into ${SOURCE}.`)
  console.error('Publishing this would ship a release every install refuses. Nothing was changed.')
  process.exit(1)
}

const release = JSON.parse(gh('release', 'view', tag, '--json', 'isDraft,assets'))

if (!release.isDraft) {
  console.error(`${tag} is already published. Signing has to happen before it is visible.`)
  process.exit(1)
}

const INSTALLER = /\.(exe|dmg|AppImage)$/
const installers = release.assets.map((a) => a.name).filter((n) => INSTALLER.test(n))

// A release missing a platform is the failure this repo has shipped before, and
// it is far cheaper to catch here than after somebody cannot install.
if (installers.length < 3) {
  console.error(
    `${tag} carries ${installers.length} installer(s): ${installers.join(', ') || 'none'}`
  )
  console.error('Expected all three. Refusing to publish half a release.')
  process.exit(1)
}

mkdirSync(dir, { recursive: true })
console.log(`Downloading ${installers.length} installers to ${dir}`)
gh(
  'release',
  'download',
  tag,
  '--dir',
  dir,
  '--clobber',
  ...installers.flatMap((n) => ['--pattern', n])
)

const sha512 = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest()))
  })

const signatures = []

for (const name of installers) {
  const file = join(dir, name)
  const digest = await sha512(file)
  const signature = sign(null, digest, privateKey)

  // Verified against the shipped public key, not the one just used to sign, so
  // this asserts what an installed copy of Anodex will actually conclude.
  if (!verify(null, digest, shippedKey, signature)) {
    console.error(`FAILED verification against ${SOURCE}: ${name}`)
    process.exit(1)
  }

  const sigPath = `${file}.sig`
  writeFileSync(sigPath, `${signature.toString('base64')}\n`)
  signatures.push(sigPath)
  console.log(`  signed ${name}`)
}

console.log('Uploading signatures')
gh('release', 'upload', tag, ...signatures, '--clobber')

console.log('Publishing')
gh('release', 'edit', tag, '--draft=false')

console.log(`\n${tag} is published and signed. Installs will accept it; nothing else will.`)
