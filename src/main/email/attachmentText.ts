import { htmlToPlainText } from './mime'
import { extractPdfText } from '../tools/pdfText'

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

  if (type === 'application/pdf')
    return capped(await extractPdfText(data, { maxChars: MAX_ATTACHMENT_TEXT_CHARS }))
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
