import { inflateRawSync } from 'node:zlib'

/** Office files bigger than this are matched by name only. */
export const MAX_OFFICE_FILE_BYTES = 25 * 1024 * 1024
/** A single entry may not inflate past this: the guard against zip bombs. */
const MAX_ENTRY_BYTES = 20 * 1024 * 1024
const MAX_ENTRIES = 5_000

/** Which parts of each format hold the words a person typed. */
const TEXT_PARTS: Record<string, (name: string) => boolean> = {
  '.docx': (name) => name === 'word/document.xml',
  '.xlsx': (name) =>
    name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
  '.pptx': (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name),
  '.odt': (name) => name === 'content.xml',
  '.ods': (name) => name === 'content.xml',
  '.odp': (name) => name === 'content.xml'
}

export function isOfficeFile(extension: string): boolean {
  return extension in TEXT_PARTS
}

/**
 * The text of an Office or OpenDocument file: a zip of XML, read with Node's
 * own inflate rather than a dependency. Reads only the parts that hold the
 * document's words, refuses entries that inflate past a fixed size, and
 * returns '' for anything it cannot make sense of rather than throwing: this
 * feeds a search, where an unreadable file is simply not a content match.
 */
export function officeText(data: Buffer, extension: string): string {
  const wanted = TEXT_PARTS[extension]
  if (!wanted || data.length > MAX_OFFICE_FILE_BYTES) return ''
  try {
    const parts: string[] = []
    for (const entry of zipEntries(data)) {
      if (!wanted(entry.name)) continue
      const xml = entry.read()
      if (xml) parts.push(xmlToText(xml))
    }
    return parts.join('\n')
  } catch {
    return ''
  }
}

interface ZipEntry {
  name: string
  read: () => string | null
}

/** Entries from the zip's central directory, which is the authoritative list. */
function* zipEntries(data: Buffer): Generator<ZipEntry> {
  const end = findEndOfCentralDirectory(data)
  if (end < 0) return
  const count = data.readUInt16LE(end + 10)
  let offset = data.readUInt32LE(end + 16)
  for (let i = 0; i < Math.min(count, MAX_ENTRIES); i++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) return
    const method = data.readUInt16LE(offset + 10)
    const compressedSize = data.readUInt32LE(offset + 20)
    const size = data.readUInt32LE(offset + 24)
    const nameLength = data.readUInt16LE(offset + 28)
    const extraLength = data.readUInt16LE(offset + 30)
    const commentLength = data.readUInt16LE(offset + 32)
    const localOffset = data.readUInt32LE(offset + 42)
    const name = data.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength
    yield {
      name,
      read: () => {
        if (size > MAX_ENTRY_BYTES) return null
        if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50)
          return null
        const start =
          localOffset +
          30 +
          data.readUInt16LE(localOffset + 26) +
          data.readUInt16LE(localOffset + 28)
        const raw = data.subarray(start, start + compressedSize)
        if (method === 0) return raw.toString('utf8')
        if (method !== 8) return null
        return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8')
      }
    }
  }
}

function findEndOfCentralDirectory(data: Buffer): number {
  // The record is 22 bytes, followed by a comment of up to 64KB.
  const stop = Math.max(0, data.length - 22 - 0xffff)
  for (let i = data.length - 22; i >= stop; i--) {
    if (data.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

/** Words out of document XML: tags become spaces, entities are decoded. */
function xmlToText(xml: string): string {
  return xml
    .replace(/<\/(w:p|a:p|text:p|row|si)>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
}
