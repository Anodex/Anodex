import { beforeAll, describe, expect, it } from 'vitest'
import { extractPdfText } from '../pdfText'
import { tinyPdf } from './tinyPdf'
import { warmPdfParser } from './test-helpers'

describe('PDF text extraction', () => {
  // Loading pdf.js inside the first test's own timeout is what failed CI on the
  // slowest runner. See `warmPdfParser`.
  beforeAll(warmPdfParser, 60_000)

  it('reads the text layer of a PDF', async () => {
    const text = await extractPdfText(new Uint8Array(tinyPdf('Bundled scenarios Solar System')))
    expect(text).toContain('Bundled scenarios Solar System')
  })

  it('does not detach the caller’s buffer', async () => {
    // pdf.js takes ownership of the array it is given; `extractPdfText` copies
    // first so a caller that reuses its bytes is not left holding an empty one.
    const bytes = new Uint8Array(tinyPdf('Reusable bytes'))
    await extractPdfText(bytes)
    expect(bytes.byteLength).toBeGreaterThan(0)
    await expect(extractPdfText(bytes)).resolves.toContain('Reusable bytes')
  })

  it('rejects a file that is not a PDF at all', async () => {
    await expect(extractPdfText(new Uint8Array(Buffer.from('not a pdf')))).rejects.toThrow()
  })

  it('honours the page ceiling', async () => {
    // A zero page budget must produce the no-text-layer error rather than
    // silently returning an empty string that would read as a blank source.
    await expect(
      extractPdfText(new Uint8Array(tinyPdf('Ignored')), { maxPages: 0 })
    ).rejects.toThrow(/no text layer/)
  })
})
