import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every spacing token a stylesheet uses must exist.
 *
 * A missing custom property does not fail loudly: the declaration that uses it
 * is dropped. The Critical Thinking report asked for `clamp(…, var(--space-7))`
 * when the scale skips from 6 to 8, so its whole padding was thrown away and the
 * report text sat against the card's edge for months, looking like a layout
 * choice rather than a typo.
 */
const RENDERER = join(__dirname, '..', '..')

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : cssFiles(path)
    return name.endsWith('.css') ? [path] : []
  })
}

describe('spacing tokens', () => {
  const theme = readFileSync(join(RENDERER, 'styles', 'theme.css'), 'utf8')
  const defined = new Set([...theme.matchAll(/(--space-\d+)\s*:/g)].map((match) => match[1]))

  it('are defined', () => {
    expect(defined.size).toBeGreaterThan(4)
  })

  it('are only used where the theme defines them', () => {
    const missing = cssFiles(RENDERER).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/var\((--space-\d+)\)/g)]
        .filter((match) => !defined.has(match[1]))
        .map((match) => `${relative(RENDERER, file)}: ${match[1]}`)
    )
    expect(missing).toEqual([])
  })
})
