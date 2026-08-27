import { describe, expect, it } from 'vitest'
import { extractPdfText } from '../pdfText'
import { tinyPdf } from './tinyPdf'

describe('PDF text extraction', () => {
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
