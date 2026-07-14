import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertValidSlug, changeProposalPath, listChanges } from '../changeCatalog'
import {
  archiveChangeMarkdown,
  createChangeMarkdown,
  slugify,
  updateChangeTaskMarkdown
} from '../changeLibrary'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anodex-change-library-'))
}

describe('slugify', () => {
  it('lowercases and dashes a title', () => {
    expect(slugify('Add Dark Mode')).toBe('add-dark-mode')
  })

  it('falls back to "change" for a title with no usable characters', () => {
    expect(slugify('!!!')).toBe('change')
  })
})

describe('assertValidSlug', () => {
  it('accepts anything slugify() could produce', () => {
    expect(() => assertValidSlug('add-dark-mode')).not.toThrow()
    expect(() => assertValidSlug('add-dark-mode-2')).not.toThrow()
    expect(() => assertValidSlug('change')).not.toThrow()
  })

  it('rejects path traversal segments', () => {
    expect(() => assertValidSlug('..')).toThrow(/not a valid change slug/)
    expect(() => assertValidSlug('..\\..\\outside')).toThrow(/not a valid change slug/)
    expect(() => assertValidSlug('../../outside')).toThrow(/not a valid change slug/)
  })

  it('rejects absolute-looking paths and separators', () => {
    expect(() => assertValidSlug('C:\\Windows')).toThrow(/not a valid change slug/)
    expect(() => assertValidSlug('foo/bar')).toThrow(/not a valid change slug/)
    expect(() => assertValidSlug('foo\\bar')).toThrow(/not a valid change slug/)
  })

  it('rejects empty, uppercase, and overlong slugs', () => {
    expect(() => assertValidSlug('')).toThrow(/not a valid change slug/)
    expect(() => assertValidSlug('Add-Dark-Mode')).toThrow(/not a valid change slug/)
    expect(() => assertValidSlug('a'.repeat(65))).toThrow(/not a valid change slug/)
  })
})

describe('createChangeMarkdown', () => {
  it('writes a proposal.md with the given title/why/tasks', () => {
    const workspaceRoot = makeTempDir()
    const change = createChangeMarkdown(workspaceRoot, 'Add dark mode', 'Users asked for it.', [
      'Add theme context',
      'Add CSS variables'
    ])

    expect(change.slug).toBe('add-dark-mode')
    expect(change.status).toBe('proposed')
    expect(change.tasks).toEqual([
      { title: 'Add theme context', done: false },
      { title: 'Add CSS variables', done: false }
    ])
    expect(existsSync(changeProposalPath(workspaceRoot, 'add-dark-mode'))).toBe(true)
  })

  it('disambiguates a slug collision by appending -2', () => {
    const workspaceRoot = makeTempDir()
    createChangeMarkdown(workspaceRoot, 'Add dark mode', 'First.', [])
    const second = createChangeMarkdown(workspaceRoot, 'Add dark mode', 'Second.', [])

    expect(second.slug).toBe('add-dark-mode-2')
  })
})

describe('updateChangeTaskMarkdown', () => {
  it('marks a task done and updates status to in_progress when not all tasks are done', () => {
    const workspaceRoot = makeTempDir()
    createChangeMarkdown(workspaceRoot, 'Add dark mode', 'Why.', ['Step one', 'Step two'])

    const updated = updateChangeTaskMarkdown(workspaceRoot, 'add-dark-mode', 0, true)

    expect(updated.status).toBe('in_progress')
    expect(updated.tasks[0].done).toBe(true)
    expect(updated.tasks[1].done).toBe(false)
  })

  it('sets status to done once every task is done', () => {
    const workspaceRoot = makeTempDir()
    createChangeMarkdown(workspaceRoot, 'Add dark mode', 'Why.', ['Step one'])

    const updated = updateChangeTaskMarkdown(workspaceRoot, 'add-dark-mode', 0, true)

    expect(updated.status).toBe('done')
  })

  it('throws for an unknown slug', () => {
    expect(() => updateChangeTaskMarkdown(makeTempDir(), 'does-not-exist', 0, true)).toThrow(
      /No change named "does-not-exist"/
    )
  })

  it('throws for an out-of-range task position', () => {
    const workspaceRoot = makeTempDir()
    createChangeMarkdown(workspaceRoot, 'Add dark mode', 'Why.', ['Only task'])

    expect(() => updateChangeTaskMarkdown(workspaceRoot, 'add-dark-mode', 5, true)).toThrow(
      /has no task at position 6/
    )
  })

  it('rejects a traversal slug instead of resolving outside the workspace', () => {
    const workspaceRoot = makeTempDir()
    expect(() => updateChangeTaskMarkdown(workspaceRoot, '..\\..\\outside', 0, true)).toThrow(
      /not a valid change slug/
    )
  })
})

describe('archiveChangeMarkdown', () => {
  it('moves the change out of the active list and creates SPEC.md', () => {
    const workspaceRoot = makeTempDir()
    createChangeMarkdown(workspaceRoot, 'Add dark mode', 'Users asked for it.', ['Step one'])

    archiveChangeMarkdown(workspaceRoot, 'add-dark-mode')

    expect(listChanges(workspaceRoot)).toEqual([])
    const specPath = join(workspaceRoot, '.anodex', 'SPEC.md')
    expect(existsSync(specPath)).toBe(true)
    const spec = readFileSync(specPath, 'utf-8')
    expect(spec).toContain('## Add dark mode')
    expect(spec).toContain('Users asked for it.')
    expect(spec).toContain('- Step one')
  })

  it('appends a second archived change to the same SPEC.md rather than overwriting it', () => {
    const workspaceRoot = makeTempDir()
    createChangeMarkdown(workspaceRoot, 'Add dark mode', 'First reason.', [])
    archiveChangeMarkdown(workspaceRoot, 'add-dark-mode')
    createChangeMarkdown(workspaceRoot, 'Add search', 'Second reason.', [])
    archiveChangeMarkdown(workspaceRoot, 'add-search')

    const spec = readFileSync(join(workspaceRoot, '.anodex', 'SPEC.md'), 'utf-8')
    expect(spec).toContain('## Add dark mode')
    expect(spec).toContain('## Add search')
  })

  it('throws for an unknown slug', () => {
    expect(() => archiveChangeMarkdown(makeTempDir(), 'does-not-exist')).toThrow(
      /No change named "does-not-exist"/
    )
  })

  it('rejects a traversal slug and never deletes anything outside the workspace', () => {
    // A directory that would be the rmSync target if the traversal worked —
    // a sibling of the temp workspace, i.e. genuinely outside it.
    const parent = mkdtempSync(join(tmpdir(), 'anodex-change-library-outside-'))
    const victimMarker = join(parent, 'victim.txt')
    writeFileSync(victimMarker, 'do not delete me')

    const workspaceRoot = makeTempDir()
    const changesDir = join(workspaceRoot, '.anodex', 'changes')
    mkdirSync(changesDir, { recursive: true })
    // Relative traversal from workspaceRoot/.anodex/changes/<slug> up to `parent`.
    const traversalSlug = '..\\..\\..\\' + dirname(victimMarker).split(/[\\/]/).pop()

    expect(() => archiveChangeMarkdown(workspaceRoot, traversalSlug)).toThrow(
      /not a valid change slug/
    )
    expect(existsSync(victimMarker)).toBe(true)
  })
})
