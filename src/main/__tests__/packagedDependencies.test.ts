import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What the packaged app is allowed to leave out.
 *
 * `electron-builder.yml` drops a handful of `node_modules` from the asar because
 * Vite bundles them into the renderer and their package sources would otherwise
 * ship a second time for nothing. The list carried a warning: if a main-process
 * file ever imports one of them, the packaged app fails at require-time while
 * working perfectly in dev — and it asked whoever moved code into `src/main` to
 * re-check it.
 *
 * That is not a check. It is a request, and in 0.10.0 it was not honoured.
 * `diffRows.ts` moved into `src/shared` so the main process could draw a diff
 * for a phone; `diff` stayed excluded; the packaged main process threw
 * MODULE_NOT_FOUND before it reached its first line of work. `npm run build`
 * passed, every test passed, three platform installers built and signed, and
 * the app opened on an error dialog with no listener behind it — so a paired
 * phone could not reach the computer at all.
 *
 * The one thing that would have caught it is this: read the exclusions, read
 * what main and preload actually import, and refuse to let the two disagree.
 */

const ROOT = resolve(__dirname, '..', '..', '..')

/** Package names excluded from the packaged app, as `!node_modules/<name>/**` lines. */
function excludedPackages(): string[] {
  const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
  return [...yml.matchAll(/^\s*-\s*'!node_modules\/((?:@[^/]+\/)?[^/']+)\/\*\*/gm)].map(
    (match) => match[1]
  )
}

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      found.push(...sourceFiles(path))
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry)) {
      found.push(path)
    }
  }
  return found
}

/**
 * Every bare package name imported by a tree.
 *
 * `src/shared` counts as part of both, and that is the whole point: nothing in
 * `src/main` imported `diff` directly. It imported `@shared/checkpointDiff`,
 * which imports `./diffRows`, which imports `diff`. A check that only looked at
 * `src/main` would have passed while the app was broken.
 */
function importedPackages(dirs: string[]): Set<string> {
  const packages = new Set<string>()
  for (const dir of dirs) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const source = readFileSync(file, 'utf8')
      for (const [, specifier] of source.matchAll(/(?:from\s+|require\(\s*)['"]([^'"]+)['"]/g)) {
        // Relative paths and the repo's own aliases are not packages.
        if (specifier.startsWith('.') || specifier.startsWith('@shared/')) continue
        if (specifier.startsWith('@main/') || specifier.startsWith('@renderer/')) continue
        if (specifier.startsWith('node:') || specifier === 'electron') continue

        const parts = specifier.split('/')
        packages.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0])
      }
    }
  }
  return packages
}

describe('what the packaged app leaves out', () => {
  it('excludes nothing the main process actually imports', () => {
    // The assertion that would have stopped 0.10.0 from shipping.
    const excluded = excludedPackages()
    const imported = importedPackages(['src/main', 'src/preload', 'src/shared'])

    const broken = excluded.filter((name) => imported.has(name))

    expect(
      broken,
      `electron-builder.yml drops ${broken.join(', ')} from the asar, but the main or ` +
        'preload tree imports it. The packaged app will throw MODULE_NOT_FOUND at ' +
        'startup while `npm run dev` works. Remove the exclusion, or stop importing it ' +
        'outside the renderer.'
    ).toEqual([])
  })

  it('is reading both halves, rather than passing on an empty list', () => {
    // A check that finds nothing to compare reports success. Both sides have to
    // be non-trivial for the assertion above to mean anything.
    expect(excludedPackages().length).toBeGreaterThan(0)
    expect(importedPackages(['src/main', 'src/preload', 'src/shared']).size).toBeGreaterThan(10)
  })

  it('still sees the import chain that broke it, three files deep', () => {
    // `src/main` → `@shared/checkpointDiff` → `./diffRows` → `diff`. Pinned
    // because a later refactor that narrows this to direct imports of `src/main`
    // would re-open the exact hole, and would still pass the first test.
    expect(importedPackages(['src/main', 'src/preload', 'src/shared'])).toContain('diff')
  })
})
