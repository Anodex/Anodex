import { describe, expect, it, vi } from 'vitest'
import type { AttachmentContent } from '@shared/chat.types'
import type { Result } from '@shared/result'
import {
  intakeAttachments,
  MAX_ATTACHMENTS,
  type AttachmentIntake,
  type ComposerAttachment
} from '../attachments'

function textFile(sizeBytes = 10): Result<AttachmentContent> {
  return { ok: true, value: { kind: 'text', content: 'x', sizeBytes, truncated: false } }
}

function imageFile(): Result<AttachmentContent> {
  return {
    ok: true,
    value: {
      kind: 'image',
      dataUrl: 'data:image/png;base64,AA',
      mimeType: 'image/png',
      sizeBytes: 4,
      truncated: false
    }
  }
}

/**
 * Stands in for the composer's ref-backed list: `commit` applies immediately
 * and `getAttachments` reads what has already been applied, exactly as the
 * component's `attachmentsRef` does.
 */
function harness(
  readFile: (path: string) => Promise<Result<AttachmentContent>>,
  visionAvailable = true
): { intake: AttachmentIntake; list: () => ComposerAttachment[]; errors: string[][] } {
  let attachments: ComposerAttachment[] = []
  const errors: string[][] = []
  return {
    list: () => attachments,
    errors,
    intake: {
      getAttachments: () => attachments,
      commit: (update) => {
        attachments = update(attachments)
      },
      readFile,
      notifyError: (title, message) => errors.push([title, message]),
      visionAvailable
    }
  }
}

/** A read that only resolves when the test says so, so passes can be interleaved. */
function gatedReader(): {
  read: (path: string) => Promise<Result<AttachmentContent>>
  release: () => void
  pending: () => number
} {
  const waiting: (() => void)[] = []
  return {
    pending: () => waiting.length,
    release: () => {
      const queued = waiting.splice(0, waiting.length)
      for (const resolve of queued) resolve()
    },
    read: async () => {
      await new Promise<void>((resolve) => waiting.push(resolve))
      return textFile()
    }
  }
}

describe('intakeAttachments', () => {
  it('attaches text and image candidates', async () => {
    const h = harness((path) => Promise.resolve(path.endsWith('.png') ? imageFile() : textFile(42)))
    await intakeAttachments(
      [
        { path: '/a/notes.txt', name: 'notes.txt' },
        { path: '/a/shot.png', name: 'shot.png' }
      ],
      h.intake
    )

    expect(h.list().map((a) => [a.kind, a.name])).toEqual([
      ['text', 'notes.txt'],
      ['image', 'shot.png']
    ])
    expect(h.errors).toEqual([])
  })

  it('reports a failed read once and keeps going', async () => {
    const h = harness((path) =>
      Promise.resolve(
        path.includes('locked')
          ? { ok: false, error: { code: 'attachments.read-failed', message: 'Permission denied' } }
          : textFile()
      )
    )
    await intakeAttachments(
      [
        { path: '/a/locked.txt', name: 'locked.txt' },
        { path: '/a/ok.txt', name: 'ok.txt' }
      ],
      h.intake
    )

    expect(h.list().map((a) => a.name)).toEqual(['ok.txt'])
    expect(h.errors).toEqual([['Could not attach file', 'Permission denied']])
  })

  it('skips a path that is already attached', async () => {
    const h = harness(() => Promise.resolve(textFile()))
    await intakeAttachments([{ path: '/a/one.txt', name: 'one.txt' }], h.intake)
    await intakeAttachments([{ path: '/a/one.txt', name: 'one.txt' }], h.intake)

    expect(h.list()).toHaveLength(1)
  })

  it('refuses images without a vision-capable model', async () => {
    const h = harness(() => Promise.resolve(imageFile()), false)
    await intakeAttachments([{ path: '/a/shot.png', name: 'shot.png' }], h.intake)

    expect(h.list()).toEqual([])
    expect(h.errors[0][0]).toBe('Vision model required')
  })

  it('caps images independently of the overall attachment cap', async () => {
    const h = harness(() => Promise.resolve(imageFile()))
    await intakeAttachments(
      Array.from({ length: 6 }, (_, i) => ({ path: `/a/${i}.png`, name: `${i}.png` })),
      h.intake
    )

    expect(h.list()).toHaveLength(4)
    expect(h.errors.filter(([title]) => title === 'Too many images')).toHaveLength(2)
  })

  it('names the limit once when more files are offered than fit', async () => {
    const h = harness(() => Promise.resolve(textFile()))
    await intakeAttachments(
      Array.from({ length: MAX_ATTACHMENTS + 5 }, (_, i) => ({
        path: `/a/${i}.txt`,
        name: `${i}.txt`
      })),
      h.intake
    )

    expect(h.list()).toHaveLength(MAX_ATTACHMENTS)
    // One notice, and it states the limit rather than claiming a count of
    // additions it cannot know.
    expect(h.errors).toEqual([
      [
        'Too many attachments',
        `A message can carry ${MAX_ATTACHMENTS} files. The rest were skipped.`
      ]
    ])
  })

  // The two below are the regressions the round-two review of `ChatComposer`
  // found: both passes previously read the list once, before the loop, so
  // neither could see what the other had added while it was awaiting a read.

  it('does not attach the same file twice when two passes race on it', async () => {
    const gate = gatedReader()
    const h = harness(gate.read)

    const first = intakeAttachments([{ path: '/a/same.txt', name: 'same.txt' }], h.intake)
    const second = intakeAttachments([{ path: '/a/same.txt', name: 'same.txt' }], h.intake)
    // Both passes are now parked inside their read, each having checked an
    // empty list — the exact window a second drop of an in-flight file opens.
    await vi.waitFor(() => expect(gate.pending()).toBe(2))
    gate.release()
    await Promise.all([first, second])

    expect(h.list()).toHaveLength(1)
    // `path` is the React key for this list and the only thing the remove
    // button filters on, so a duplicate is not merely redundant.
    expect(new Set(h.list().map((a) => a.path)).size).toBe(h.list().length)
  })

  it('holds the attachment cap across two racing passes', async () => {
    const gate = gatedReader()
    const h = harness(gate.read)
    const batch = (prefix: string): { path: string; name: string }[] =>
      Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({
        path: `/a/${prefix}${i}.txt`,
        name: `${prefix}${i}.txt`
      }))

    let finished = 0
    const done = (): void => {
      finished += 1
    }
    const first = intakeAttachments(batch('x'), h.intake).then(done)
    const second = intakeAttachments(batch('y'), h.intake).then(done)
    // Drain both passes: settle lets each one reach its next parked read, then
    // a release lets every parked read resolve at once. Bounded so a stalled
    // pass fails the assertion rather than hanging the suite.
    for (let step = 0; finished < 2 && step < MAX_ATTACHMENTS * 4; step++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      gate.release()
    }
    await Promise.all([first, second])

    expect(h.list()).toHaveLength(MAX_ATTACHMENTS)
  })
})
