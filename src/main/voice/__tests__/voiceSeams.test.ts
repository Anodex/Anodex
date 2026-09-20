import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Voice has to be removable, and this is what makes that true rather than
 * intended.
 *
 * The requirement was stated before any of it was written: if voice does not work
 * out it comes out cleanly and nothing else notices. A rule that lives only in a
 * document decays — somebody reaches into the voice module from the chat pipeline
 * for one good reason, and a year later removing voice means reading every file
 * that ever touched it.
 *
 * So the rule is enforced here, the way `channelPolicy` enforces its own: by
 * reading the tree. Outside the voice directories, a file may import voice at
 * exactly one place, that place must be marked, and the complete list of such
 * files is written below. Adding a seam means adding a line here, in a review,
 * on purpose.
 *
 * `docs/HANDOFF_VOICE.md` §9.1 and §9.2.
 */

/**
 * Every file outside the voice module that is allowed to know voice exists.
 *
 * If this list grows past about a dozen, the design has gone wrong and the doc
 * says so. Each entry is one guarded call or one import supporting it.
 */
const ALLOWED_SEAMS = new Set([
  // Announces `voice.1` on the handshake when voice is switched on.
  join('src', 'main', 'remote', 'capabilities.ts'),
  // Routes binary frames to voice, and writes them back.
  join('src', 'main', 'remote', 'RemoteBridge.ts'),
  // Registers the handlers behind reading a reply aloud.
  join('src', 'main', 'ipc', 'index.ts'),
  // Puts the listen control in a reply's footer.
  join('src', 'renderer', 'features', 'chat', 'MessageBubble.tsx')
])

/**
 * Voice is two directories, not one: what speaks, and what a window shows for
 * it. Both are deleted together, so both are exempt from the rule they exist to
 * make enforceable.
 */
const VOICE_ROOTS = [join('src', 'main', 'voice'), join('src', 'renderer', 'features', 'voice')]
const SOURCE_ROOT = 'src'

function sourceFiles(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue
      found.push(...sourceFiles(full))
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      found.push(full)
    }
  }
  return found
}

function importsVoice(contents: string): boolean {
  return /from\s+['"][^'"]*\/voice\/[^'"]*['"]/.test(contents)
}

describe('voice stays inside its own directory', () => {
  const files = sourceFiles(SOURCE_ROOT)
    .map((file) => relative(process.cwd(), file))
    .filter((file) => !VOICE_ROOTS.some((root) => file.startsWith(root + sep)))
    .filter((file) => !file.includes('__tests__'))

  const reaching = files.filter((file) => importsVoice(readFileSync(file, 'utf8')))

  it('is reached from nowhere that is not a listed seam', () => {
    // The failure this prevents: voice quietly becoming load-bearing for
    // something that is not voice.
    expect(new Set(reaching)).toEqual(ALLOWED_SEAMS)
  })

  it('marks every seam so removal is a grep and not archaeology', () => {
    for (const file of reaching) {
      expect(
        readFileSync(file, 'utf8'),
        `${file} imports voice without a voice:seam marker`
      ).toMatch(/voice:seam/)
    }
  })

  it('keeps the number of seams small enough to hold in one head', () => {
    expect(ALLOWED_SEAMS.size).toBeLessThanOrEqual(12)
  })
})
