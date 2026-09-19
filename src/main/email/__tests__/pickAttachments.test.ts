import { describe, expect, it } from 'vitest'
import { mimeTypeOf } from '../pickAttachments'
import { readableAttachmentSize } from '@shared/email.types'

/**
 * Turning chosen files into something a mail server will take.
 *
 * The dialog itself is Electron's and not worth wrapping in a test; what is
 * worth pinning is everything that decides whether the recipient can open
 * what arrives, and whether the sender learns about a size limit from this
 * window or from a bounce an hour later.
 */
describe('mimeTypeOf', () => {
  it('names the types a recipient will want opened inline', () => {
    expect(mimeTypeOf('/tmp/chart.png')).toBe('image/png')
    expect(mimeTypeOf('/tmp/scan.PDF')).toBe('application/pdf')
    expect(mimeTypeOf('C:/Users/one/notes.md')).toBe('text/markdown')
  })

  it('does not guess', () => {
    // `application/octet-stream` is the honest answer for a type we do not
    // know, and every client handles it by offering to save the file.
    // Guessing wrong is worse: a .docx labelled text/plain opens as gibberish
    // in a preview pane, and the recipient concludes the file is corrupt.
    expect(mimeTypeOf('/tmp/archive.7z')).toBe('application/octet-stream')
    expect(mimeTypeOf('/tmp/noextension')).toBe('application/octet-stream')
    expect(mimeTypeOf('/tmp/.gitignore')).toBe('application/octet-stream')
  })

  it('does not care how the extension was typed', () => {
    expect(mimeTypeOf('/tmp/HOLIDAY.JPEG')).toBe('image/jpeg')
  })
})

describe('readableAttachmentSize', () => {
  // One function, in `shared`, used by the window and by the refusal. It
  // started as two copies with a test pinning that they matched, which is a
  // worse version of one copy -- and the test could not even be written,
  // because a main-process test may not import renderer code.
  it('speaks the units mail providers state their limits in', () => {
    expect(readableAttachmentSize(18 * 1024 * 1024)).toBe('18 MB')
    expect(readableAttachmentSize(4.25 * 1024 * 1024)).toBe('4.3 MB')
  })

  it('does not call a small file 0.0 MB', () => {
    // A row reading "report.csv - 0.0 MB" looks like a file that failed to
    // attach. Below a tenth of a megabyte the useful unit is kilobytes.
    expect(readableAttachmentSize(40 * 1024)).toBe('40 KB')
    expect(readableAttachmentSize(12)).toBe('1 KB')
  })
})
