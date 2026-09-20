import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every directory the packaged app reads, checked against the ones it ships.
 *
 * `process.resourcesPath` exists only in a packaged build, and every caller
 * below falls back to `resources/` in the working tree when running from source.
 * That fallback is what makes this worth a test: a resource missing from
 * `extraResources` works perfectly in development, passes every other test, and
 * is absent only in the installed application — where nobody looks until a user
 * reports a feature that silently does nothing.
 *
 * It has already happened once. `resources/voice` holds the reference clip every
 * spoken sentence is conditioned on, and it was not listed. Voice was merged,
 * green, and would have shipped with no voice at all: the button never appears,
 * because the clip it needs is not in the package, and nothing says so.
 *
 * So the rule is read off the code rather than remembered.
 */

const ROOT = process.cwd()

/** Directory names the main process joins onto `process.resourcesPath`. */
function resourcesReadAtRuntime(): Set<string> {
  const found = new Set<string>()
  const pattern = /process\.resourcesPath\s*,\s*['"]([^'"]+)['"]/g

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry)
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === '__tests__') continue
        walk(full)
      } else if (entry.endsWith('.ts')) {
        const contents = readFileSync(full, 'utf8')
        for (const match of contents.matchAll(pattern)) found.add(match[1])
      }
    }
  }

  walk(join(ROOT, 'src', 'main'))
  return found
}

/** The `to:` of every `extraResources` entry in the builder config. */
function resourcesShipped(): Set<string> {
  const config = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
  const section = config.slice(config.indexOf('extraResources:'))
  const end = section.search(/\n[a-z]/)
  const entries = end === -1 ? section : section.slice(0, end)
  return new Set([...entries.matchAll(/^\s+to:\s*(\S+)\s*$/gm)].map((match) => match[1]))
}

describe('what the installed application can actually read', () => {
  it('ships every directory the main process reads from resourcesPath', () => {
    const wanted = resourcesReadAtRuntime()
    const shipped = resourcesShipped()

    // Not an equality check: the config may ship things nothing reads by this
    // pattern — LICENSE.md is there to be opened by a person, not by code.
    const missing = [...wanted].filter((name) => !shipped.has(name))
    expect(missing, `not in electron-builder.yml extraResources: ${missing.join(', ')}`).toEqual([])
  })

  it('reads the config it thinks it is reading', () => {
    // If the parsing above ever silently matches nothing, the test above passes
    // for the worst possible reason.
    const shipped = resourcesShipped()
    expect(shipped.size).toBeGreaterThan(3)
    expect(shipped).toContain('llama-server')
  })
})
