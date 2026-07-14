import { describe, expect, it } from 'vitest'
import { parseChangeFile, serializeChangeFile } from '../changeFile'

const VALID = `---
title: Add dark mode
status: proposed
createdAt: 2026-07-14T12:00:00.000Z
updatedAt: 2026-07-14T12:00:00.000Z
---

## Why

Users have asked for a dark theme option.

## Tasks

- [ ] Add a theme context provider
- [x] Add CSS variables
`

describe('parseChangeFile', () => {
  it('parses a well-formed change file', () => {
    const change = parseChangeFile(VALID, '/changes/add-dark-mode/proposal.md')

    expect(change.title).toBe('Add dark mode')
    expect(change.status).toBe('proposed')
    expect(change.why).toBe('Users have asked for a dark theme option.')
    expect(change.tasks).toEqual([
      { title: 'Add a theme context provider', done: false },
      { title: 'Add CSS variables', done: true }
    ])
    expect(change.createdAt).toBe('2026-07-14T12:00:00.000Z')
    expect(change.updatedAt).toBe('2026-07-14T12:00:00.000Z')
  })

  it('defaults to an empty task list when the Tasks section is missing', () => {
    const raw = `---\ntitle: X\nstatus: proposed\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\n## Why\n\nReason.\n`
    const change = parseChangeFile(raw, '/changes/x/proposal.md')

    expect(change.tasks).toEqual([])
    expect(change.why).toBe('Reason.')
  })

  it('throws when the file does not start with a frontmatter block', () => {
    expect(() => parseChangeFile('title: x\n', '/changes/bad/proposal.md')).toThrow(
      /must start with a "---" frontmatter block/
    )
  })

  it('throws when the frontmatter block is unterminated', () => {
    const raw = `---\ntitle: x\nstatus: proposed\n`
    expect(() => parseChangeFile(raw, '/changes/bad/proposal.md')).toThrow(
      /unterminated frontmatter/
    )
  })

  it('throws when a required field is missing', () => {
    const raw = `---\ntitle: x\n---\nBody.\n`
    expect(() => parseChangeFile(raw, '/changes/bad/proposal.md')).toThrow(
      /missing required field "status"/
    )
  })

  it('throws on an invalid status value', () => {
    const raw = `---\ntitle: x\nstatus: bogus\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\nBody.\n`
    expect(() => parseChangeFile(raw, '/changes/bad/proposal.md')).toThrow(/invalid status "bogus"/)
  })
})

describe('serializeChangeFile', () => {
  it('round-trips through parseChangeFile', () => {
    const original = parseChangeFile(VALID, '/changes/add-dark-mode/proposal.md')
    const reparsed = parseChangeFile(
      serializeChangeFile(original),
      '/changes/add-dark-mode/proposal.md'
    )

    expect(reparsed).toEqual(original)
  })

  it('renders an empty task list as no checkbox lines', () => {
    const serialized = serializeChangeFile({
      title: 'X',
      status: 'proposed',
      why: 'Reason.',
      tasks: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    const reparsed = parseChangeFile(serialized, '/changes/x/proposal.md')

    expect(reparsed.tasks).toEqual([])
  })

  it('collapses a multiline title to one line instead of corrupting the frontmatter', () => {
    const serialized = serializeChangeFile({
      title: 'Add dark mode\nwith a bogus continuation line',
      status: 'proposed',
      why: 'Reason.',
      tasks: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })

    // Must not throw — a raw embedded newline would otherwise either break
    // frontmatter parsing outright or get read back as a bogus extra field.
    const reparsed = parseChangeFile(serialized, '/changes/x/proposal.md')
    expect(reparsed.title).toBe('Add dark mode with a bogus continuation line')
    expect(reparsed.status).toBe('proposed')
  })

  it('collapses a multiline task title instead of corrupting later task positions', () => {
    const serialized = serializeChangeFile({
      title: 'X',
      status: 'proposed',
      why: 'Reason.',
      tasks: [
        { title: 'First line\nSecond line', done: false },
        { title: 'A real second task', done: false }
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    const reparsed = parseChangeFile(serialized, '/changes/x/proposal.md')

    expect(reparsed.tasks).toEqual([
      { title: 'First line Second line', done: false },
      { title: 'A real second task', done: false }
    ])
  })

  it('keeps a "why" paragraph containing a heading-shaped line instead of truncating it', () => {
    const serialized = serializeChangeFile({
      title: 'X',
      status: 'proposed',
      why: 'Some context.\n\n## Migration plan\n\nStep one, then step two.',
      tasks: [{ title: 'Do the thing', done: false }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    const reparsed = parseChangeFile(serialized, '/changes/x/proposal.md')

    expect(reparsed.why).toContain('## Migration plan')
    expect(reparsed.why).toContain('Step one, then step two.')
    expect(reparsed.tasks).toEqual([{ title: 'Do the thing', done: false }])
  })
})
