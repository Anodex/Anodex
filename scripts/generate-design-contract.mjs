/**
 * Emit `protocol/anodex-design.json` — the look, in a form another repository can check.
 *
 * `generate-protocol.mjs` exists because two repositories cannot typecheck each other. This
 * exists for the half of the seam that is not types at all. The phone's palette, spacing,
 * radii and icon paths are copied from this repository by hand, and the phone's own tests
 * say so in as many words:
 *
 *     "What this can and cannot do: it catches a change made on *this* side, which is the
 *      common case, because the phone is where the copying happens. It cannot see the
 *      desktop, so a value changed there and not here still passes."
 *
 * That is the gap. A colour edited here and nowhere else produces no error anywhere — the
 * two apps simply drift, slowly, in a way nobody notices until they are side by side.
 *
 * This artifact is the desktop half made readable. The phone vendors it and pins its own
 * values against it, so the drift becomes a failing test in the repository that has to act
 * on it rather than a difference nobody is looking at.
 *
 * ## What it does not do
 *
 * It does not generate Kotlin. A generated theme file would be worse than the copying: the
 * phone's colours are typed `Color`, its spacing is `Dp`, and several values are
 * deliberately *not* the desktop's — `AnodexColors` documents four inks that exist because
 * the desktop's accents are unreadable on the phone's surfaces. Copying by hand and
 * checking by machine keeps those decisions visible and still catches the accidents.
 *
 * ## Usage
 *
 *     node scripts/generate-design-contract.mjs           # write the artifact
 *     node scripts/generate-design-contract.mjs --check   # fail if it differs from what is committed
 */

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIDNIGHT = path.join(ROOT, 'src', 'renderer', 'styles', 'themes', 'midnight.css')
const THEME = path.join(ROOT, 'src', 'renderer', 'styles', 'theme.css')
const ICONS = path.join(ROOT, 'src', 'renderer', 'components', 'Icon.tsx')
const OUTPUT = path.join(ROOT, 'protocol', 'anodex-design.json')

/**
 * Bump the major when a name disappears or changes meaning, the minor when one is added.
 * A phone reading an older major should say so rather than quietly pinning nothing.
 */
const DESIGN_VERSION = '1.0.0'

/**
 * Custom properties from the first `:root` block only.
 *
 * `midnight.css` carries the light overrides further down under their own selector, and a
 * file-wide scan picks those up instead — the same mistake that once reported sixteen
 * palette "drifts" that were the light theme all along.
 */
function readRootBlock(file) {
  const source = fs.readFileSync(file, 'utf8')
  const start = source.indexOf(':root {')
  if (start === -1) throw new Error(`no :root block in ${path.basename(file)}`)

  const open = source.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) throw new Error(`unterminated :root block in ${path.basename(file)}`)

  const block = source.slice(open, end)
  const values = {}
  // Comments can contain anything that looks like a declaration, so they go first.
  for (const [, name, value] of block
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    values[name] = value.trim().replace(/\s+/g, ' ')
  }
  return values
}

/**
 * Every glyph, as the elements it is drawn from, in order.
 *
 * Not just `<path d>`. Fifteen of these are built from `<line>`, `<circle>`, `<rect>` and
 * `<polyline>` instead, and a first version of this script read only `d` attributes — so it
 * emitted a contract that was quietly missing a fifth of the icon set, including `close` and
 * `plus`. A contract with holes in it is worse than none, because the holes pass.
 *
 * Hence `declaredNames`: every name in the `IconName` union must come out of the table with
 * something in it, or this refuses to write a file at all.
 *
 * Order is part of the contract. The phone asserts the list, and two elements swapped is a
 * glyph drawn in the wrong order.
 */
function declaredNames(source) {
  const union = source.slice(0, source.indexOf('GLYPHS'))
  return new Set([...union.matchAll(/^\s*\|\s*'([a-z0-9-]+)'/gm)].map((match) => match[1]))
}

function readGlyphs() {
  const source = fs.readFileSync(ICONS, 'utf8')
  const start = source.indexOf('GLYPHS')
  if (start === -1) throw new Error('no GLYPHS table in Icon.tsx')

  const glyphs = {}
  // Entries look like `name: <path d="…" />` or `'name': (<><line … /></>)`.
  const entry = /(?:^|\n)\s{2}'?([a-z0-9-]+)'?:\s*(\(?[\s\S]*?)(?=\n\s{2}'?[a-z0-9-]+'?:|\n\}\s*$)/g
  for (const [, name, body] of source.slice(start).matchAll(entry)) {
    const elements = []
    const paths = []
    for (const [, tag, attributes] of body.matchAll(
      /<(path|line|circle|rect|polyline|polygon|ellipse)\s+([^>]*?)\/?>/g
    )) {
      // `[a-zA-Z-]+` would not do: `x1` and `y2` have digits in them, and an
      // attribute pattern that cannot match them turns `<line>` into `line ` —
      // a glyph present in the contract and empty inside it.
      const pairs = [...attributes.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g)].map(
        ([, key, value]) => `${key}="${value.replace(/\s+/g, ' ').trim()}"`
      )
      elements.push(`${tag} ${pairs.join(' ')}`)
      const d = attributes.match(/\sd="([^"]+)"|^d="([^"]+)"/)
      if (tag === 'path' && d) paths.push((d[1] ?? d[2]).replace(/\s+/g, ' ').trim())
    }
    // An element that came out with no attributes means the reader matched the
    // tag and not its contents — present in the contract and empty inside it,
    // which is the hole that passes.
    const hollow = elements.filter((element) => !element.includes('="'))
    if (hollow.length > 0) {
      throw new Error(`read ${name} as ${hollow.length} shape(s) with no attributes`)
    }
    if (elements.length > 0) glyphs[name] = { elements, paths }
  }

  const missing = [...declaredNames(source)].filter((name) => !glyphs[name])
  if (missing.length > 0) {
    throw new Error(`read no shape for ${missing.length} declared glyph(s): ${missing.join(', ')}`)
  }
  return glyphs
}

const theme = readRootBlock(THEME)
const contract = {
  $comment:
    'Generated by scripts/generate-design-contract.mjs. The desktop half of a seam the phone copies by hand.',
  version: DESIGN_VERSION,
  midnight: readRootBlock(MIDNIGHT),
  scale: Object.fromEntries(
    Object.entries(theme).filter(
      ([name]) => name.startsWith('--space-') || name.startsWith('--radius-')
    )
  ),
  glyphs: readGlyphs()
}

const serialised = `${JSON.stringify(contract, null, 2)}\n`

if (process.argv.includes('--check')) {
  const existing = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : ''
  if (existing !== serialised) {
    console.error(
      'protocol/anodex-design.json is out of date — run `npm run design` and commit the result.'
    )
    process.exit(1)
  }
  console.log('protocol/anodex-design.json is up to date')
} else {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  fs.writeFileSync(OUTPUT, serialised)
  console.log(
    `wrote protocol/anodex-design.json — ${Object.keys(contract.midnight).length} midnight values, ` +
      `${Object.keys(contract.scale).length} scale steps, ${Object.keys(contract.glyphs).length} glyphs`
  )
}
