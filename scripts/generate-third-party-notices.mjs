/**
 * Generates `THIRD-PARTY-NOTICES.md` — the notice file that ships with Anodex.
 *
 * `LICENSE.md` promises that "where a third-party licence requires a notice,
 * that notice travels with the component in the installed application". Almost
 * every licence in the tree is a retain-the-notice licence, so that promise is
 * only kept if the notices are actually collected and packaged. This is what
 * collects them; `electron-builder.yml` is what packages the result.
 *
 * Run `npm run notices` to regenerate, `npm run notices:check` to fail when the
 * committed file has drifted from the installed tree. The output is fully
 * deterministic — no dates, no app version — so `--check` only fires on a real
 * change in what ships.
 *
 * Two things this deliberately does not do:
 *
 * 1. It does not shell out to `npm ls --omit=dev`. That reports the *declared*
 *    production tree, and what ships is not the same set — see
 *    `BUNDLED_DEV_DEPENDENCIES` below. It walks `node_modules` from the shipped
 *    roots instead, the way Node itself resolves.
 * 2. It does not silently drop a package it cannot find a licence file for.
 *    Those are listed in their own section with whatever the package's own
 *    metadata claims, because an absent notice is the thing this file exists to
 *    catch.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const OUTPUT = join(ROOT, 'THIRD-PARTY-NOTICES.md')
const SOURCE_ROOT = join(ROOT, 'src')

/**
 * Notices are per-installer, not per-repository. npm installs only the optional
 * binaries matching the host, and `@node-llama-cpp/win-x64`, `@reflink/*` and
 * friends genuinely do not ship in a macOS build — so a Windows installer
 * listing macOS binaries would be wrong, not more complete. The generated file
 * records which platform it describes, and `--check` refuses to compare across
 * platforms rather than pass on a file it cannot verify.
 */
const PLATFORM = `${process.platform}-${process.arch}`
const PLATFORM_LINE = `Generated for **${PLATFORM}** from the installed dependency tree.`

/**
 * devDependencies whose code is nonetheless *shipped*, because Vite bundles
 * them into `out/renderer`. They are dev dependencies only in the sense that
 * nothing resolves them from `node_modules` at runtime — their code is in the
 * product, and their licence obligations apply.
 *
 * `assertNoUnlistedDevDependencyShips()` fails the build if a devDependency is
 * imported from `src/` without being named here, so this list cannot quietly go
 * stale the next time a library moves.
 */
const BUNDLED_DEV_DEPENDENCIES = ['react', 'react-dom']

/**
 * Imported from `src/` and a devDependency, but not bundled by us:
 * electron-builder ships Electron's own `LICENSE.electron.txt` and
 * `LICENSES.chromium.html` into the packaged app, and the runtime is described
 * by hand in `BUNDLED_COMPONENTS` because it is not an npm dependency of the
 * product in any useful sense.
 */
const DEV_DEPENDENCIES_HANDLED_ELSEWHERE = ['electron']

/**
 * Everything in the installer that did not come out of `node_modules`: two
 * downloaded/bundled binaries and one artwork lineage. Each `licenseFile` is a
 * verbatim upstream licence text committed next to the component it covers, so
 * the notice and the thing it describes cannot be separated by accident.
 */
const BUNDLED_COMPONENTS = [
  {
    name: 'llama.cpp / ggml',
    version: 'release b10549 (pinned in scripts/prepare-llama-server.mjs)',
    license: 'MIT',
    source: 'https://github.com/ggml-org/llama.cpp',
    licenseFile: 'resources/llama-server/LICENSE-llama.cpp.txt',
    note: [
      'The official prebuilt llama.cpp runtime, downloaded by `npm run prepare:vision`',
      'and packaged into `resources/llama-server/`. Anodex starts `llama-server` on',
      'loopback for multimodal models. The upstream release archives ship the binaries',
      'without llama.cpp’s own LICENSE file, so this copy is supplied by Anodex and',
      'copied in beside the binaries at prepare time.'
    ].join(' ')
  },
  {
    name: 'nomic-embed-text-v1.5 (Q4_K_M GGUF)',
    version: 'nomic-embed-text-v1.5.Q4_K_M.gguf',
    license: 'Apache-2.0',
    source: 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF',
    licenseFile: 'resources/embedding-model/LICENSE.txt',
    note: [
      'Model weights by Nomic AI, bundled into the installer and used for local semantic',
      'code search. Provenance is recorded and verifiable in',
      '`resources/embedding-model/NOTICE.md`.'
    ].join(' ')
  },
  {
    name: 'Lucide (and Feather, for the icons Lucide derives from it)',
    version: 'artwork lineage, not a dependency',
    license: 'ISC (portions MIT)',
    source: 'https://github.com/lucide-icons/lucide',
    licenseFile: 'src/renderer/assets/LICENSE-lucide.txt',
    note: [
      'Anodex draws its own glyphs inline in `src/renderer/components/Icon.tsx` rather',
      'than depending on an icon package, but much of that set began as Lucide artwork',
      'and some of it still follows Lucide’s geometry closely. Attribution is given on',
      'that basis.'
    ].join(' ')
  },
  {
    name: 'Electron',
    version: readVersionOf('electron'),
    license: 'MIT',
    source: 'https://github.com/electron/electron',
    licenseFile: 'node_modules/electron/LICENSE',
    note: [
      'The application runtime. Electron bundles Chromium (BSD-3-Clause plus a large',
      'third-party set) and Node.js (MIT); electron-builder copies Electron’s own',
      '`LICENSE.electron.txt` and the full `LICENSES.chromium.html` into the packaged',
      'application, so those notices ship in addition to this one.'
    ].join(' ')
  }
]

/**
 * Directories under `src/` that hold test code. Nothing in them is bundled, so
 * their imports must not be mistaken for shipped dependencies — `test-utils` in
 * particular looks like ordinary source and imports `vitest` outright.
 */
const TEST_DIRECTORIES = new Set(['__tests__', '__mocks__', 'test-utils', 'node_modules'])

/**
 * The provider marks that ship inside the renderer bundle.
 *
 * Trademarks are not licensed components and have no licence text to reproduce,
 * which is exactly why they go missing from a notices file: nothing in the
 * dependency tree points at them and no scanner reports them. They are in the
 * installer all the same, so the position Anodex takes on them belongs here
 * rather than nowhere.
 *
 * Names only. The artwork's provenance — official brand page, asset pack or
 * simple-icons, with retrieval dates — is recorded beside the files themselves
 * in `src/renderer/assets/providers/SOURCES.md`, which is where somebody
 * changing one will be looking.
 */
const PROVIDER_MARKS = {
  'anthropic.svg': 'Anthropic',
  'openai.svg': 'OpenAI',
  'azure-openai.svg': 'Azure OpenAI',
  'google.svg': 'Google',
  'deepseek.svg': 'DeepSeek',
  'groq.svg': 'Groq',
  'kimi.svg': 'Kimi (Moonshot AI)',
  'mistral.svg': 'Mistral AI',
  'openrouter.svg': 'OpenRouter',
  'qwen.svg': 'Qwen',
  'xai.svg': 'xAI'
}

const PROVIDER_MARKS_DIR = join(ROOT, 'src', 'renderer', 'assets', 'providers')

/** Files a package might carry its licence text in. */
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-][\w.-]*)?$/i

const mode = process.argv.includes('--check') ? 'check' : 'write'

const manifest = await readJson(join(ROOT, 'package.json'))
await assertNoUnlistedDevDependencyShips(manifest)
await assertEveryProviderMarkIsDeclared()

const shipped = await collectShippedPackages(manifest)
const rendered = await render(shipped)

if (mode === 'check') {
  const current = existsSync(OUTPUT) ? await readFile(OUTPUT, 'utf8') : ''
  const committedFor = /Generated for \*\*([\w-]+)\*\*/.exec(current)?.[1]
  if (committedFor && committedFor !== PLATFORM) {
    process.stderr.write(
      `THIRD-PARTY-NOTICES.md was generated for ${committedFor}, and this is ${PLATFORM}. ` +
        'The two cannot be compared — the installed optional binaries differ. Run this check ' +
        `on ${committedFor}.\n`
    )
    process.exit(1)
  }
  if (current !== rendered) {
    process.stderr.write(
      'THIRD-PARTY-NOTICES.md is out of date with the installed dependency tree.\n' +
        'Run `npm run notices` and commit the result.\n'
    )
    process.exit(1)
  }
  process.stdout.write(`THIRD-PARTY-NOTICES.md is up to date (${shipped.length} packages).\n`)
} else {
  await writeFile(OUTPUT, rendered)
  process.stdout.write(
    `Wrote THIRD-PARTY-NOTICES.md — ${shipped.length} npm packages, ` +
      `${BUNDLED_COMPONENTS.length} bundled components.\n`
  )
}

/**
 * Walks `node_modules` the way Node resolves, starting from the dependencies
 * that ship, and returns every package reachable from them.
 */
async function collectShippedPackages(manifest) {
  const roots = [...Object.keys(manifest.dependencies ?? {}), ...BUNDLED_DEV_DEPENDENCIES].sort()

  const found = new Map()
  const queue = roots.map((name) => ({ name, from: ROOT }))
  const seen = new Set()

  while (queue.length > 0) {
    const { name, from } = queue.shift()
    const directory = resolvePackageDirectory(from, name)
    if (!directory) {
      // Not installed. An optional dependency for another platform is the usual
      // reason; either way it is not in this build, so it has no notice to give.
      continue
    }
    if (seen.has(directory)) continue
    seen.add(directory)

    const packageManifest = await readJson(join(directory, 'package.json'))
    const key = `${packageManifest.name}@${packageManifest.version}`
    if (!found.has(key)) {
      found.set(key, await describePackage(directory, packageManifest))
    }

    // `peerDependencies` are deliberately not followed. A peer dependency is
    // one the *consumer* supplies, and everything this tree asks for as a peer
    // is supplied by Anodex's own devDependencies, where it is build-time only.
    // Checked against `npm ls --omit=dev` rather than assumed: the entire
    // difference between that listing and this walk is four packages, reached
    // only as peers, none of which contributes runtime code —
    //
    //   @types/react, @types/prop-types, csstype   type declarations, no JS
    //   typescript                                 the compiler, a peer of
    //                                              node-llama-cpp and of the
    //                                              eslint plugins
    //
    // If a production package ever declares a peer dependency it genuinely
    // loads at runtime, that package would ship without a notice. Re-run the
    // comparison when the dependency tree changes shape, and add it as a root
    // here if one appears.
    for (const dependency of [
      ...Object.keys(packageManifest.dependencies ?? {}),
      ...Object.keys(packageManifest.optionalDependencies ?? {})
    ]) {
      queue.push({ name: dependency, from: directory })
    }
  }

  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * `require.resolve`'s directory walk, stopped at the repository root so a
 * globally installed copy can never be mistaken for something we ship.
 */
function resolvePackageDirectory(from, name) {
  let directory = from
  for (;;) {
    const candidate = join(directory, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (directory === ROOT) return null
    const parent = dirname(directory)
    if (parent === directory || !parent.startsWith(ROOT)) return null
    directory = parent
  }
}

async function describePackage(directory, packageManifest) {
  const entries = await readdir(directory, { withFileTypes: true })
  const licenseFiles = entries
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort()

  const texts = []
  for (const filename of licenseFiles) {
    const text = (await readFile(join(directory, filename), 'utf8')).replace(/\r\n/g, '\n').trim()
    if (text.length > 0) texts.push({ filename, text })
  }

  return {
    id: `${packageManifest.name}@${packageManifest.version}`,
    name: packageManifest.name,
    version: packageManifest.version,
    license: spdxOf(packageManifest),
    homepage: homepageOf(packageManifest),
    texts
  }
}

function spdxOf(packageManifest) {
  if (typeof packageManifest.license === 'string') return packageManifest.license
  if (packageManifest.license?.type) return packageManifest.license.type
  if (Array.isArray(packageManifest.licenses)) {
    return packageManifest.licenses.map((entry) => entry.type ?? entry).join(' OR ')
  }
  return 'UNDECLARED'
}

/**
 * The link shown for a package that ships no licence text of its own, which is
 * the only way left to find out who holds its copyright. `repository` is spelled
 * half a dozen ways in the wild, npm's shorthands included, so normalise it to
 * something clickable rather than printing `develar/lazy-val` and leaving the
 * reader to guess the host.
 */
function homepageOf(packageManifest) {
  const repository = packageManifest.repository
  const url = typeof repository === 'string' ? repository : repository?.url
  if (!url) return packageManifest.homepage ?? ''
  const normalized = url
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^(github|gitlab|bitbucket):/, (_, host) => `https://${host}.com/`)
  // npm's bare `owner/repo` shorthand, which means GitHub.
  return /^[\w.-]+\/[\w.-]+$/.test(normalized) ? `https://github.com/${normalized}` : normalized
}

/**
 * Identical licence texts are printed once and shared. Most of the tree is MIT,
 * but MIT texts differ by copyright line, so this collapses far less than it
 * looks like it should — which is the correct outcome: a copyright line is the
 * part of an MIT notice that has to be retained.
 */
function groupByLicenseText(packages) {
  const groups = new Map()
  for (const entry of packages) {
    if (entry.texts.length === 0) continue
    const body = entry.texts.map((text) => text.text).join('\n\n')
    const key = createHash('sha256').update(`${entry.license} ${body}`).digest('hex')
    const group = groups.get(key) ?? { license: entry.license, body, packages: [] }
    group.packages.push(entry)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => {
    const byLicense = a.license.localeCompare(b.license)
    return byLicense !== 0 ? byLicense : a.packages[0].id.localeCompare(b.packages[0].id)
  })
}

async function render(packages) {
  const lines = []
  const missing = packages.filter((entry) => entry.texts.length === 0)

  lines.push('# Third-party notices')
  lines.push('')
  lines.push(
    'Anodex is built on software written by other people. This file collects the licences',
    'and copyright notices of everything that ships inside the application, so that the',
    'notices those licences require travel with the product.',
    ''
  )
  lines.push(
    '**None of the terms in [`LICENSE.md`](LICENSE.md) apply to anything listed here.** Each',
    'component below remains under its own licence, held by its own authors, and that licence',
    'governs it entirely. Nothing in this file, or in Anodex’s own licence, claims ownership',
    'of anything Anodex did not write.',
    ''
  )
  lines.push(
    PLATFORM_LINE,
    'Each platform’s installer carries its own copy, because the prebuilt binaries in the tree',
    'differ between them. Produced by `scripts/generate-third-party-notices.mjs` — do not edit by',
    'hand; run `npm run notices`. `npm run dist` regenerates it for whichever platform is being',
    'packaged, and `npm run notices:check` fails when it has drifted from what is installed.',
    ''
  )
  lines.push('---', '')

  lines.push('## Bundled components')
  lines.push('')
  lines.push(
    'These are not npm packages, which means no dependency scanner sees them. They are the',
    'binaries, weights and artwork that ship inside the installer.',
    ''
  )
  for (const component of BUNDLED_COMPONENTS) {
    lines.push(`### ${component.name}`)
    lines.push('')
    lines.push(`- **Licence:** ${component.license}`)
    lines.push(`- **Version:** ${component.version}`)
    lines.push(`- **Source:** ${component.source}`)
    lines.push(`- **Licence text:** \`${component.licenseFile}\``)
    lines.push('')
    lines.push(component.note)
    lines.push('')
    lines.push('```text')
    lines.push(await readBundledLicense(component))
    lines.push('```')
    lines.push('')
  }

  lines.push('---', '')
  lines.push('## Trademarks')
  lines.push('')
  lines.push(
    'Anodex connects to model providers, and shows each provider\u2019s logo next to the',
    'connection it belongs to. Those logos ship inside the application:',
    ''
  )
  for (const mark of Object.values(PROVIDER_MARKS)) lines.push(`- ${mark}`)
  lines.push('')
  lines.push(
    '**These are trademarks, not licensed components.** Each mark belongs to the company it',
    'names. No licence to them is granted by this file, by Anodex\u2019s own licence, or by the',
    'fact that the artwork is visible in this source.',
    ''
  )
  lines.push(
    'They are used to identify a real integration and nothing else \u2014 the OpenAI mark appears',
    'against the OpenAI connection because that is what it connects to. The artwork ships',
    'unmodified, is never restyled or recoloured, and is never used as decoration or to suggest',
    'that any of these companies endorses, sponsors or is affiliated with Anodex. None of them',
    'does.',
    ''
  )
  lines.push(
    'Provenance for every mark \u2014 the official brand page, asset pack or CC0 source it came',
    'from, and when \u2014 is recorded in `src/renderer/assets/providers/SOURCES.md`.',
    ''
  )
  lines.push(
    'If you own one of these marks and object to how it is used here, say so and it will be',
    'removed: <https://github.com/Anodex/Anodex/issues>, or the private channel in',
    '`SECURITY.md` if you would rather not do it in public.',
    ''
  )
  lines.push('---', '')
  lines.push('## npm packages')
  lines.push('')
  lines.push(
    `${packages.length} packages ship inside the application. The list is every package`,
    'reachable from Anodex’s production dependencies, plus the dev dependencies whose code',
    'Vite bundles into the renderer (they are dev dependencies only in the sense that nothing',
    'resolves them at runtime — their code is in the product).',
    ''
  )

  const counts = new Map()
  for (const entry of packages) counts.set(entry.license, (counts.get(entry.license) ?? 0) + 1)
  lines.push('| Licence | Packages |')
  lines.push('| ------- | -------- |')
  for (const [license, count] of [...counts].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )) {
    lines.push(`| ${license} | ${count} |`)
  }
  lines.push('')

  if (missing.length > 0) {
    lines.push('### Packages published without a licence file')
    lines.push('')
    lines.push(
      'These declare a licence in their `package.json` but ship no licence text of their own,',
      'so there is no notice to reproduce. Listed rather than omitted, because a missing notice',
      'is the thing this file exists to surface.',
      ''
    )
    for (const entry of missing) {
      const link = entry.homepage ? ` — ${entry.homepage}` : ''
      lines.push(`- \`${entry.id}\` — declared **${entry.license}**${link}`)
    }
    lines.push('')
  }

  lines.push('### Licences and copyright notices')
  lines.push('')
  for (const group of groupByLicenseText(packages)) {
    lines.push(`#### ${group.license}`)
    lines.push('')
    lines.push('Applies to:')
    lines.push('')
    for (const entry of group.packages.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`- \`${entry.id}\``)
    }
    lines.push('')
    lines.push('```text')
    lines.push(group.body)
    lines.push('```')
    lines.push('')
  }

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

async function readBundledLicense(component) {
  const path = join(ROOT, component.licenseFile.split('/').join(sep))
  if (!existsSync(path)) {
    throw new Error(
      `Missing licence text for bundled component "${component.name}": ` +
        `${component.licenseFile} does not exist. It has to ship with the component.`
    )
  }
  return (await readFile(path, 'utf8')).replace(/\r\n/g, '\n').trim()
}

/**
 * The failure this guards against is silent: a library moves from
 * `dependencies` to `devDependencies` (or arrives there, as React did, because
 * Vite bundles it and nothing requires it at runtime), the production tree walk
 * stops seeing it, and its notice quietly disappears from a file whose whole
 * job is to not have holes in it.
 */
async function assertNoUnlistedDevDependencyShips(manifest) {
  const devDependencies = Object.keys(manifest.devDependencies ?? {}).filter(
    (name) =>
      !name.startsWith('@types/') &&
      !BUNDLED_DEV_DEPENDENCIES.includes(name) &&
      !DEV_DEPENDENCIES_HANDLED_ELSEWHERE.includes(name)
  )
  if (devDependencies.length === 0) return

  const imported = await collectSourceImports(SOURCE_ROOT)
  const unlisted = devDependencies.filter((name) => imported.has(name)).sort()
  if (unlisted.length > 0) {
    throw new Error(
      `These devDependencies are imported from src/ and so ship inside the app, but are ` +
        `not accounted for in scripts/generate-third-party-notices.mjs: ${unlisted.join(', ')}. ` +
        `Add them to BUNDLED_DEV_DEPENDENCIES (their notices must ship) or to ` +
        `DEV_DEPENDENCIES_HANDLED_ELSEWHERE (with a comment saying where).`
    )
  }
}

/**
 * A mark that ships without being declared is the failure this prevents.
 *
 * Nothing in the dependency tree points at these files, so adding a twelfth
 * provider logo would put a twelfth trademark in the installer and leave this
 * file still listing eleven — silently, and in the one document whose job is to
 * declare what ships. `docs/THIRD_PARTY_AUDIT.md` already managed to say
 * "twelve" while listing eleven, which is the same mistake made by hand.
 */
async function assertEveryProviderMarkIsDeclared() {
  const files = (await readdir(PROVIDER_MARKS_DIR)).filter((name) => name.endsWith('.svg')).sort()
  const declared = Object.keys(PROVIDER_MARKS).sort()

  const undeclared = files.filter((name) => !declared.includes(name))
  const missing = declared.filter((name) => !files.includes(name))
  if (undeclared.length === 0 && missing.length === 0) return

  const problems = []
  if (undeclared.length > 0) {
    problems.push(`ship but are not declared: ${undeclared.join(', ')}`)
  }
  if (missing.length > 0) {
    problems.push(`are declared but no longer exist: ${missing.join(', ')}`)
  }
  throw new Error(
    `Provider marks in src/renderer/assets/providers/ ${problems.join('; ')}. ` +
      'Update PROVIDER_MARKS in scripts/generate-third-party-notices.mjs, and the ' +
      'provenance table in that directory\u2019s SOURCES.md.'
  )
}

/** Bare package specifiers imported by non-test source files. */
async function collectSourceImports(directory) {
  const specifiers = new Set()
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (TEST_DIRECTORIES.has(entry.name)) continue
      for (const specifier of await collectSourceImports(path)) specifiers.add(specifier)
      continue
    }
    if (!/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) continue
    if (/\.(test|spec)\.[jt]sx?$/.test(entry.name)) continue

    const source = await readFile(path, 'utf8')
    for (const match of source.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1]
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
        continue
      }
      const parts = specifier.split('/')
      specifiers.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0])
    }
  }
  return specifiers
}

function readVersionOf(name) {
  const path = join(ROOT, 'node_modules', name, 'package.json')
  if (!existsSync(path)) return 'not installed'
  return JSON.parse(readFileSync(path, 'utf8')).version
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}
