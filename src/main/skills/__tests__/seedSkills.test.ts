import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOOL_CATALOG } from '@shared/tools.types'
import { MAX_SKILL_BODY_CHARS } from '../activeSkillContext'
import { parseSkillFile } from '../skillFile'
import { skillFileNameFromSkillName } from '../skillLibrary'
import { seedPersonalSkills } from '../seedSkills'

/** The real `resources/skills` directory that ships inside the app. */
const BUNDLED_DIR = resolve('resources/skills')

/** Mirrors `printWidth` in `.prettierrc` — see the frontmatter test below. */
const PRETTIER_PRINT_WIDTH = 100

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anodex-seed-'))
}

function makeBundle(files: Record<string, string>): string {
  const dir = join(makeTempDir(), 'bundled')
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf-8')
  }
  return dir
}

describe('seedPersonalSkills', () => {
  it('copies bundled samples into an empty personal library', () => {
    const bundledDir = makeBundle({ 'a.md': 'alpha', 'b.md': 'beta' })
    const personalDir = join(makeTempDir(), 'skills')

    const seeded = seedPersonalSkills({ bundledDir, personalDir })

    expect(seeded).toEqual(['a.md', 'b.md'])
    expect(readFileSync(join(personalDir, 'a.md'), 'utf-8')).toBe('alpha')
  })

  it('does not re-seed a sample the user deleted', () => {
    const bundledDir = makeBundle({ 'a.md': 'alpha' })
    const personalDir = join(makeTempDir(), 'skills')

    expect(seedPersonalSkills({ bundledDir, personalDir })).toEqual(['a.md'])
    // Simulate the user deleting every sample, then relaunching.
    writeFileSync(join(personalDir, 'a.md'), 'alpha', 'utf-8')
    const secondRun = seedPersonalSkills({ bundledDir, personalDir })

    expect(secondRun).toEqual([])
  })

  it('never overwrites a sample the user edited', () => {
    const bundledDir = makeBundle({ 'a.md': 'alpha' })
    const personalDir = join(makeTempDir(), 'skills')
    mkdirSync(personalDir, { recursive: true })
    writeFileSync(join(personalDir, 'a.md'), 'my own version', 'utf-8')

    const seeded = seedPersonalSkills({ bundledDir, personalDir })

    expect(seeded).toEqual([])
    expect(readFileSync(join(personalDir, 'a.md'), 'utf-8')).toBe('my own version')
  })

  it('ignores non-markdown files in the bundle', () => {
    const bundledDir = makeBundle({ 'a.md': 'alpha', 'README.txt': 'notes' })
    const personalDir = join(makeTempDir(), 'skills')

    seedPersonalSkills({ bundledDir, personalDir })

    expect(existsSync(join(personalDir, 'README.txt'))).toBe(false)
  })

  it('is a no-op when the bundled directory is missing', () => {
    const personalDir = join(makeTempDir(), 'skills')

    expect(seedPersonalSkills({ bundledDir: join(makeTempDir(), 'absent'), personalDir })).toEqual(
      []
    )
  })
})

describe('bundled sample skills', () => {
  const files = readdirSync(BUNDLED_DIR).filter((name) => name.endsWith('.md'))

  it('ships at least one sample', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  // `parseSkillFile` rejects any frontmatter line without a colon, so a line
  // Prettier reflows onto a continuation line turns the skill unloadable.
  // Only flow sequences (`keywords: [...]`, `tools: [...]`) are at risk —
  // plain scalars like `description:` are left alone under the default
  // `proseWrap: preserve`, so they may run long. `.prettierignore` keeps
  // Prettier off these files; this keeps them formatter-safe regardless.
  it.each(files)('%s keeps its frontmatter arrays on single lines', (file) => {
    const lines = readFileSync(join(BUNDLED_DIR, file), 'utf-8').replace(/\r\n/g, '\n').split('\n')
    const frontmatter = lines.slice(1, lines.indexOf('---', 1))

    for (const line of frontmatter) {
      expect(line).toContain(':')
      if (line.includes('[')) expect(line.length).toBeLessThanOrEqual(PRETTIER_PRINT_WIDTH)
    }
  })

  it.each(files)('%s is valid and loadable', (file) => {
    const filePath = join(BUNDLED_DIR, file)
    const skill = parseSkillFile(readFileSync(filePath, 'utf-8'), filePath)

    // A skill is saved back under a filename derived from its `name`, so a
    // mismatch here would orphan the original file the first time a user
    // edits the sample in Settings.
    expect(skillFileNameFromSkillName(skill.name)).toBe(basename(file))
    // Keywords are the only body-independent discovery signal — `find_skill`
    // indexes name + description + keywords, never the body.
    expect(skill.keywords.length).toBeGreaterThan(0)
    // Pinned skills are injected verbatim only up to this limit.
    expect(skill.body.length).toBeLessThanOrEqual(MAX_SKILL_BODY_CHARS)
    for (const tool of skill.tools) {
      expect(TOOL_CATALOG.map((entry) => entry.name)).toContain(tool)
    }
  })
})
