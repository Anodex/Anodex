import { describe, expect, it } from 'vitest'
import {
  extractAttachmentText,
  isReadableAttachmentType,
  MAX_ATTACHMENT_TEXT_CHARS
} from '../attachmentText'

/**
 * A genuine one-page PDF built by hand, so the test exercises the real pdf.js
 * parser rather than a stub of it. Offsets in the xref table are computed from
 * the assembled body — a hand-written PDF with wrong offsets still opens in
 * lenient readers, which would make this prove nothing.
 */
function onePagePdf(text: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    null // content stream, assembled below
  ]

  const stream = `BT /F1 24 Tf 72 700 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`
  const body: string[] = []
  const offsets: number[] = []
  let position = '%PDF-1.4\n'.length

  objects.forEach((object, index) => {
    const number = index + 1
    const content =
      object === null ? `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream` : object
    const chunk = `${number} 0 obj\n${content}\nendobj\n`
    offsets.push(position)
    position += chunk.length
    body.push(chunk)
  })

  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${offset.toString().padStart(10, '0')} 00000 n `)
  ].join('\n')

  return Buffer.from(
    `%PDF-1.4\n${body.join('')}${xref}\ntrailer\n<< /Size ${
      objects.length + 1
    } /Root 1 0 R >>\nstartxref\n${position}\n%%EOF`,
    'latin1'
  )
}

describe('isReadableAttachmentType', () => {
  it('claims the document formats that actually arrive by email', () => {
    expect(isReadableAttachmentType('application/pdf')).toBe(true)
    expect(isReadableAttachmentType('text/csv')).toBe(true)
    expect(isReadableAttachmentType('text/html')).toBe(true)
  })

  it('leaves images to the vision path', () => {
    expect(isReadableAttachmentType('image/png')).toBe(false)
  })

  it('falls back to the extension when the sender labelled it as bytes', () => {
    // Plenty of clients send everything as application/octet-stream.
    expect(isReadableAttachmentType('application/octet-stream', 'invoice.pdf')).toBe(true)
    expect(isReadableAttachmentType('application/octet-stream', 'archive.zip')).toBe(false)
  })
})

describe('extractAttachmentText', () => {
  // The PDF cases pay for lazily loading the PDF parser on whichever of them
  // runs first. That is milliseconds on a warm dev machine but has overrun the
  // default 5s budget on a cold CI runner, so both get room rather than the
  // suite depending on which one happens to go first.
  const pdfLoadTimeout = 30_000

  it(
    'reads the text layer out of a real PDF',
    async () => {
      const result = await extractAttachmentText(
        onePagePdf('Invoice total 42 dollars'),
        'application/pdf',
        'invoice.pdf'
      )

      expect(result.text).toContain('Invoice total 42 dollars')
      expect(result.truncated).toBe(false)
    },
    pdfLoadTimeout
  )

  it(
    'says a scan needs OCR instead of returning nothing',
    async () => {
      // No content stream text at all — the shape a scanned page takes.
      await expect(
        extractAttachmentText(onePagePdf(''), 'application/pdf', 'scan.pdf')
      ).rejects.toThrow(/OCR/)
    },
    pdfLoadTimeout
  )

  it('decodes plain text and drops a byte-order mark', async () => {
    const result = await extractAttachmentText(
      Buffer.from('﻿name,total\nacme,42', 'utf-8'),
      'text/csv',
      'rows.csv'
    )

    expect(result.text).toBe('name,total\nacme,42')
  })

  it('reduces an HTML attachment to readable text', async () => {
    const result = await extractAttachmentText(
      Buffer.from('<p>Hello <b>there</b></p><script>alert(1)</script>'),
      'text/html',
      'note.html'
    )

    expect(result.text).toBe('Hello there')
    expect(result.text).not.toContain('alert')
  })

  it('truncates rather than handing over an unbounded document', async () => {
    const result = await extractAttachmentText(
      Buffer.from('x'.repeat(MAX_ATTACHMENT_TEXT_CHARS + 500)),
      'text/plain',
      'long.txt'
    )

    expect(result.truncated).toBe(true)
    expect(result.text).toHaveLength(MAX_ATTACHMENT_TEXT_CHARS)
  })

  it('refuses a format with no text layer, naming what to do instead', async () => {
    await expect(
      extractAttachmentText(Buffer.from('PK'), 'application/zip', 'bundle.zip')
    ).rejects.toThrow(/view_email_attachment|saved and opened/)
  })
})
