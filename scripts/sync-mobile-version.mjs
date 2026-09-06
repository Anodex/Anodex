/**
 * Point `EXPECTED_MOBILE_VERSION` at whatever the phone repo actually builds.
 *
 * That constant tells a paired phone which build this desktop was released
 * alongside, and it is the only way either end can know — the repository is
 * private, so neither can ask GitHub without a credential, and a credential inside
 * a distributed app is not a secret.
 *
 * Being hand-maintained and pointing at another repository, it rotted immediately:
 * two mobile releases went out with it left behind, so the phone read as *newer*
 * than the desktop expected and the notice stayed silent — the failure is quiet by
 * design, which is exactly what let it go unnoticed.
 *
 * So it is derived rather than remembered. Run this before tagging a desktop
 * release, or any time the phone's version changes:
 *
 *     node scripts/sync-mobile-version.mjs
 *     node scripts/sync-mobile-version.mjs --check    # CI-style, writes nothing
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const constantFile = join(root, 'src', 'main', 'remote', 'mobileRelease.ts')

/** The phone repo sits beside this one; it is not a dependency and not vendored. */
const gradleFile = resolve(root, '..', 'Anodex Mobile', 'app', 'build.gradle.kts')

const check = process.argv.includes('--check')

function fail(message) {
  console.error(`\n${message}\n`)
  process.exit(1)
}

let gradle
try {
  gradle = readFileSync(gradleFile, 'utf-8')
} catch {
  // Not an error worth failing a desktop build over: the phone repo is a sibling
  // checkout, and plenty of people building Anodex will not have it.
  console.log(`No phone repo at ${gradleFile} — nothing to sync.`)
  process.exit(0)
}

const found = /versionName\s*=\s*.*?\?:\s*'?"([\d.]+)"/.exec(gradle)
if (!found) fail(`Could not read versionName out of ${gradleFile}.`)

const mobileVersion = found[1]
const source = readFileSync(constantFile, 'utf-8')
const current = /export const EXPECTED_MOBILE_VERSION = '([\d.]+)'/.exec(source)
if (!current) fail(`Could not find EXPECTED_MOBILE_VERSION in ${constantFile}.`)

if (current[1] === mobileVersion) {
  console.log(`EXPECTED_MOBILE_VERSION is ${mobileVersion} — already in step.`)
  process.exit(0)
}

if (check) {
  fail(
    `EXPECTED_MOBILE_VERSION is ${current[1]} but the phone builds ${mobileVersion}.\n\n` +
      'A phone on the newer build reads as ahead of the desktop, so it is told nothing\n' +
      'and the update notice never fires. Run:\n\n' +
      '    node scripts/sync-mobile-version.mjs'
  )
}

writeFileSync(
  constantFile,
  source.replace(
    /export const EXPECTED_MOBILE_VERSION = '[\d.]+'/,
    `export const EXPECTED_MOBILE_VERSION = '${mobileVersion}'`
  ),
  'utf-8'
)

console.log(`EXPECTED_MOBILE_VERSION: ${current[1]} → ${mobileVersion}`)
