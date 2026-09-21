/**
 * Point `EXPECTED_MOBILE_VERSION` at whatever the phone repo actually builds.
 *
 * That constant tells a paired phone which build this desktop was tested
 * against. See `mobileRelease.ts` for why the desktop holds that fact at all,
 * now that both repositories are public and the phone can read its own
 * releases directly.
 *
 * Being hand-maintained and pointing at another repository, it rotted twice:
 * two mobile releases went out with it left behind, so the phone read as *newer*
 * than the desktop expected and the notice stayed silent — the failure is quiet by
 * design, which is exactly what let it go unnoticed.
 *
 * Both times it was caught by a person, because the version of this script that
 * only read a sibling checkout exited **0** when there wasn't one — which is
 * every CI runner and every machine that has only the desktop. It reads the
 * phone's public repository as a fallback now, so `--check` is a real gate and
 * runs on every pull request.
 *
 *     npm run mobile:sync                       # write the current value
 *     npm run mobile:check                      # CI-style, writes nothing
 *     ANODEX_MOBILE_REPO=/elsewhere npm run …   # a sibling somewhere else
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const constantFile = join(root, 'src', 'main', 'remote', 'mobileRelease.ts')

/**
 * The phone repo sits beside this one; it is not a dependency and not vendored.
 *
 * Overridable so the GitHub fallback below can be exercised on a machine that
 * *does* have the sibling — an untested fallback is how this went stale in the
 * first place.
 */
const gradleFile = process.env.ANODEX_MOBILE_REPO
  ? resolve(process.env.ANODEX_MOBILE_REPO, 'app', 'build.gradle.kts')
  : resolve(root, '..', 'Anodex Mobile', 'app', 'build.gradle.kts')

const check = process.argv.includes('--check')

function fail(message) {
  console.error(`\n${message}\n`)
  process.exit(1)
}

/** Pulls `versionName` out of the phone's Gradle file, wherever it came from. */
function versionNameIn(gradle, source) {
  const found = /versionName\s*=\s*.*?\?:\s*'?"([\d.]+)"/.exec(gradle)
  if (!found) fail(`Could not read versionName out of ${source}.`)
  return found[1]
}

/**
 * The phone's version, from a sibling checkout if there is one and from GitHub
 * if there is not.
 *
 * The sibling-only version of this is why the constant kept going stale. It
 * read `../Anodex Mobile`, and when that was absent — which it is on every CI
 * runner and on any machine that only has the desktop — it printed "nothing to
 * sync" and exited **0**. A check that passes when it cannot check is not a
 * check, so nothing ever caught the drift and it was found by hand twice.
 *
 * Reading GitHub is only possible because the phone repository is public now.
 * The sibling is still preferred: it is instant, it works offline, and while
 * someone is actively changing both halves it is the one that is actually
 * true — GitHub only knows what has been pushed.
 */
async function readMobileVersion() {
  try {
    return {
      version: versionNameIn(readFileSync(gradleFile, 'utf-8'), gradleFile),
      from: 'the sibling checkout'
    }
  } catch {
    // No sibling. Fall through to the network.
  }

  const url = 'https://api.github.com/repos/Anodex/anodex-mobile/contents/app/build.gradle.kts'
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        // Present in CI, absent locally. Only raises the rate limit; the
        // repository is public either way.
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
      },
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) return { unreachable: `GitHub answered ${response.status}` }
    const body = await response.json()
    if (typeof body.content !== 'string') return { unreachable: 'GitHub returned no file content' }
    const gradle = Buffer.from(body.content, 'base64').toString('utf-8')
    return { version: versionNameIn(gradle, url), from: 'GitHub' }
  } catch (error) {
    return { unreachable: error instanceof Error ? error.message : String(error) }
  }
}

const read = await readMobileVersion()
if (read.unreachable) {
  // Deliberately not a failure. A desktop build must not break because a
  // network call did, and this is advisory either way — see the constant's own
  // comment for what it is and is not.
  console.log(`Could not read the phone's version (${read.unreachable}) — nothing to sync.`)
  process.exit(0)
}
const mobileVersion = read.version
const source = readFileSync(constantFile, 'utf-8')
const current = /export const EXPECTED_MOBILE_VERSION = '([\d.]+)'/.exec(source)
if (!current) fail(`Could not find EXPECTED_MOBILE_VERSION in ${constantFile}.`)

if (current[1] === mobileVersion) {
  console.log(`EXPECTED_MOBILE_VERSION is ${mobileVersion} — already in step (per ${read.from}).`)
  process.exit(0)
}

if (check) {
  fail(
    `EXPECTED_MOBILE_VERSION is ${current[1]} but the phone builds ${mobileVersion} ` +
      `(per ${read.from}).\n\n` +
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

console.log(`EXPECTED_MOBILE_VERSION: ${current[1]} → ${mobileVersion} (per ${read.from})`)
