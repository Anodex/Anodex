import { htmlToPlainText } from './mime'

/**
 * Text extraction for email attachments the model should *read* rather than
 * look at.
 *
 * The vision path (`view_email_attachment`) covers pictures. This covers the
 * other half of what actually arrives in a mailbox — invoices, statements,
 * resumes, exported spreadsheets — which until now the model could only see as
 * a filename and a byte count.
 */

/**
 * Ceiling on extracted text. Generous, because the point of reading a
 * statement is to answer questions about its contents, but bounded: a 200-page
 * PDF would otherwise fill the model's whole context with one tool result.
 */
export const MAX_ATTACHMENT_TEXT_CHARS = 20_000

/** How many PDF pages are worth walking before the cap makes the rest moot. */
const MAX_PDF_PAGES = 50

/** Decoded straight from bytes; no parsing beyond a charset assumption. */
const PLAIN_TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/xml',
  'text/xml',
  'application/rtf',
  'text/calendar'
])

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])

export interface ExtractedText {
  text: string
  truncated: boolean
}

/** True when this attachment has text worth pulling out. */
export function isReadableAttachmentType(mimeType: string, filename = ''): boolean {
  const type = normalizeType(mimeType, filename)
  return type === 'application/pdf' || PLAIN_TEXT_TYPES.has(type) || HTML_TYPES.has(type)
}

/**
 * Pull readable text out of an attachment.
 *
 * Throws for formats with no text layer rather than returning an empty string —
 * "this file has no text in it" and "this file type is not supported" lead to
 * different next steps, and a model handed an empty result will usually invent
 * the difference.
 */
export async function extractAttachmentText(
  data: Buffer,
  mimeType: string,
  filename = ''
): Promise<ExtractedText> {
  const type = normalizeType(mimeType, filename)

  if (type === 'application/pdf') return capped(await extractPdfText(data))
  if (HTML_TYPES.has(type)) return capped(htmlToPlainText(decodeText(data)))
  if (PLAIN_TEXT_TYPES.has(type)) return capped(decodeText(data))

  throw new Error(
    `"${filename || 'That attachment'}" is ${mimeType || 'an unknown type'}, which has no text to read. ` +
      'Images can be looked at with view_email_attachment; other formats have to be saved and opened.'
  )
}

/**
 * Some senders label attachments `application/octet-stream` regardless of what
 * they are, so the extension gets a say when the declared type is useless.
 * Unlike the vision path this is not a security decision — nothing here decodes
 * untrusted bytes as a different format than they are; the worst case of
 * guessing wrong is unreadable text.
 */
function normalizeType(mimeType: string, filename: string): string {
  const declared = mimeType.toLowerCase().split(';')[0].trim()
  if (declared && declared !== 'application/octet-stream') return declared

  const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  switch (extension) {
    case 'pdf':
      return 'application/pdf'
    case 'txt':
    case 'log':
      return 'text/plain'
    case 'md':
      return 'text/markdown'
    case 'csv':
      return 'text/csv'
    case 'json':
      return 'application/json'
    case 'xml':
      return 'application/xml'
    case 'html':
    case 'htm':
      return 'text/html'
    case 'ics':
      return 'text/calendar'
    default:
      return declared
  }
}

function decodeText(data: Buffer): string {
  // Strip a UTF-8 BOM, which otherwise shows up as a stray character at the
  // very start of the model's view of the file.
  const text = data.toString('utf-8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function capped(text: string): ExtractedText {
  const trimmed = text.trim()
  return trimmed.length > MAX_ATTACHMENT_TEXT_CHARS
    ? { text: trimmed.slice(0, MAX_ATTACHMENT_TEXT_CHARS), truncated: true }
    : { text: trimmed, truncated: false }
}

/**
 * Extract a PDF's text layer with pdf.js.
 *
 * Loaded through a dynamic `import()` because the package is ESM-only and the
 * main process is CommonJS — the same arrangement `node-llama-cpp` uses. The
 * worker is disabled and `isEvalSupported` turned off: this runs in the main
 * process against a file a stranger emailed, so it gets the most restricted
 * parser configuration pdf.js offers.
 */
async function extractPdfText(data: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

  const document = await pdfjs.getDocument({
    // Copied because pdf.js takes ownership of the buffer it is handed and
    // detaches it; the caller still needs its own bytes afterwards.
    data: new Uint8Array(data),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false
  }).promise

  try {
    const pages: string[] = []
    const pageCount = Math.min(document.numPages, MAX_PDF_PAGES)
    let length = 0
    for (
      let pageNumber = 1;
      pageNumber <= pageCount && length < MAX_ATTACHMENT_TEXT_CHARS;
      pageNumber++
    ) {
      const page = await document.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        const text = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/[ \t]+/g, ' ')
          .trim()
        if (text) {
          pages.push(text)
          length += text.length
        }
      } finally {
        page.cleanup()
      }
    }

    if (pages.length === 0) {
      throw new Error(
        'That PDF has no text layer — it is most likely a scan. It would need OCR to read.'
      )
    }
    return pages.join('\n\n')
  } finally {
    await document.destroy()
  }
}
