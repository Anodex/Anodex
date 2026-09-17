import { describe, expect, it } from 'vitest'
import type { CheckpointFilePreview } from '../checkpoint.types'
import { MAX_DIFF_ROWS, MAX_ROW_LENGTH, buildRemoteFileDiff } from '../checkpointDiff'

function file(
  before: string | null,
  after: string | null,
  rest: Partial<CheckpointFilePreview> = {}
): CheckpointFilePreview {
  return {
    path: 'src/sim/useDragBody.ts',
    kind: 'modified',
    before,
    after,
    binary: false,
    beforeSize: before?.length ?? null,
    afterSize: after?.length ?? null,
    conflicted: false,
    restored: false,
    ...rest
  }
}

/**
 * What crosses the wire when a phone asks what changed in one file.
 *
 * `inspect` strips file contents on purpose — a checkpoint holds the whole
 * before and after of everything it touched, and one rewritten file is a frame
 * too big to send. That left a remote client able to say *that* a file changed
 * and never *what*, which is the difference between reporting a build and
 * trusting one.
 *
 * A diff is smaller than either side of it, so the answer is built on the
 * machine that has the file. These are the rules for how much of it travels.
 */
describe('a file diff built for a phone', () => {
  it('counts the change and draws it', () => {
    const diff = buildRemoteFileDiff(file('a\nb\nc\n', 'a\nB\nc\n'))
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(diff.truncated).toBe(false)
    expect(diff.rows.map((row) => row.text)).toContain('B')
  })

  it('sends nothing to draw for a binary file, and says which it was', () => {
    // Not an error and not an empty diff: "this is a PNG" is the useful answer,
    // and a client that gets zero rows with no reason draws a blank screen.
    const diff = buildRemoteFileDiff(file(null, null, { binary: true, kind: 'created' }))
    expect(diff.binary).toBe(true)
    expect(diff.rows).toEqual([])
    expect(diff.kind).toBe('created')
  })

  it('cuts a generated file down, and still reports the whole count', () => {
    // The shape the cap exists for: every line differs, so nothing collapses.
    // The rows stop; the summary must not, or the phone under-reports the size
    // of what a restore would throw away.
    const before = Array.from({ length: 2000 }, (_, i) => `old ${i}`).join('\n')
    const after = Array.from({ length: 2000 }, (_, i) => `new ${i}`).join('\n')

    const diff = buildRemoteFileDiff(file(before, after))
    expect(diff.rows.length).toBeLessThanOrEqual(MAX_DIFF_ROWS)
    expect(diff.truncated).toBe(true)
    expect(diff.added).toBe(2000)
    expect(diff.removed).toBe(2000)
  })

  it('cuts one very long line rather than letting it be the whole frame', () => {
    // A minified bundle is one line. Without this the row cap counts it as a
    // single row and sends the entire file inside it.
    const diff = buildRemoteFileDiff(file('short\n', `${'x'.repeat(50_000)}\n`))
    for (const row of diff.rows) {
      expect(row.text.length).toBeLessThanOrEqual(MAX_ROW_LENGTH + 1)
    }
  })

  it('treats a missing side as empty, so a new file is all additions', () => {
    const diff = buildRemoteFileDiff(file(null, 'one\ntwo\n', { kind: 'created' }))
    expect(diff.removed).toBe(0)
    expect(diff.added).toBe(2)
  })

  it('treats a deletion as all removals', () => {
    const diff = buildRemoteFileDiff(file('one\ntwo\n', null, { kind: 'deleted' }))
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(2)
  })
})
