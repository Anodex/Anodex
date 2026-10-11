import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { extractPdfText } from '../tools/pdfText'
import { isOfficeFile, officeText, MAX_OFFICE_FILE_BYTES } from './officeText'

/** A file the search found, and why. */
export interface FoundFile {
  path: string
  name: string
  sizeBytes: number
  modifiedAt: number
  /** "name", or a short passage around the words found inside it. */
  matched: string
}

export interface PersonalSearchOptions {
  roots: string[]
  /** Words to look for. Every one must appear, in the name or the contents. */
  words: string[]
  /** Only files changed within this many days, when set. */
  withinDays?: number
  /** Also look inside documents. On by default. */
  searchContents?: boolean
  now?: number
  /** Stops early when the search runs this long; what it found so far is kept. */
  timeLimitMs?: number
}

const MAX_RESULTS = 20
const MAX_DEPTH = 7
const MAX_FILES_SEEN = 60_000
/** Contents are read for at most this many files, newest first. */
const MAX_CONTENT_READS = 250
const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024
const PLAIN_TEXT = new Set(['.txt', '.md', '.csv', '.json', '.log', '.html', '.htm', '.rtf'])

/** Folders a person's documents never live in, and which would only slow the search. */
const SKIPPED_FOLDERS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  'venv',
  '.venv',
  'AppData',
  'Library',
  '$RECYCLE.BIN',
  'System Volume Information'
])

interface Candidate {
  path: string
  name: string
  sizeBytes: number
  modifiedAt: number
}

/**
 * Look through the person's own folders (Documents, Desktop, Downloads and the
 * like) for a file: by name first, then inside documents for the rest.
 *
 * Bounded in every direction, because it runs while someone waits: depth, how
 * many files are listed, how many are opened, and wall-clock time. Hidden
 * files and folders are skipped, which keeps keys and settings (`.ssh`,
 * `.config`) out of it entirely.
 */
export async function searchPersonalFiles(options: PersonalSearchOptions): Promise<FoundFile[]> {
  const words = options.words.map((word) => word.toLowerCase().trim()).filter(Boolean)
  if (words.length === 0) return []
  const now = options.now ?? Date.now()
  const deadline = now + (options.timeLimitMs ?? 8_000)
  const since = options.withinDays ? now - options.withinDays * 86_400_000 : 0

  const candidates = await listFiles(options.roots, since, deadline)
  const found: FoundFile[] = []
  const rest: Candidate[] = []
  for (const file of candidates) {
    const haystack = file.path.toLowerCase()
    if (words.every((word) => haystack.includes(word))) found.push({ ...file, matched: 'name' })
    else rest.push(file)
  }

  if (options.searchContents !== false) {
    const readable = rest
      .filter((file) => contentReadable(file))
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .slice(0, MAX_CONTENT_READS)
    for (const file of readable) {
      if (Date.now() > deadline || found.length >= MAX_RESULTS * 2) break
      const text = await textOf(file)
      const lower = text.toLowerCase()
      if (text && words.every((word) => lower.includes(word))) {
        found.push({ ...file, matched: passage(text, lower, words[0]) })
      }
    }
  }

  return found
    .sort(
      (a, b) =>
        Number(b.matched === 'name') - Number(a.matched === 'name') || b.modifiedAt - a.modifiedAt
    )
    .slice(0, MAX_RESULTS)
}

async function listFiles(roots: string[], since: number, deadline: number): Promise<Candidate[]> {
  const files: Candidate[] = []
  const seen = new Set<string>()
  const queue = roots.map((dir) => ({ dir, depth: 0 }))
  while (queue.length > 0 && files.length < MAX_FILES_SEEN && Date.now() < deadline) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number }
    if (seen.has(dir)) continue
    seen.add(dir)
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIPPED_FOLDERS.has(entry.name))
          queue.push({ dir: path, depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stats = await stat(path)
        if (stats.mtimeMs < since) continue
        files.push({ path, name: basename(path), sizeBytes: stats.size, modifiedAt: stats.mtimeMs })
      } catch {
        // gone, or not ours to read
      }
    }
  }
  return files
}

function contentReadable(file: Candidate): boolean {
  const extension = extname(file.name).toLowerCase()
  if (PLAIN_TEXT.has(extension)) return file.sizeBytes <= MAX_TEXT_FILE_BYTES
  if (extension === '.pdf' || isOfficeFile(extension))
    return file.sizeBytes <= MAX_OFFICE_FILE_BYTES
  return false
}

async function textOf(file: Candidate): Promise<string> {
  const extension = extname(file.name).toLowerCase()
  try {
    const data = await readFile(file.path)
    if (PLAIN_TEXT.has(extension)) return data.toString('utf8')
    if (isOfficeFile(extension)) return officeText(data, extension)
    if (extension === '.pdf') return await extractPdfText(data, { maxPages: 20, maxChars: 200_000 })
  } catch {
    // unreadable, encrypted, or a scan with no text layer
  }
  return ''
}

/** A short stretch of text around the first word found, for the model to judge by. */
function passage(text: string, lower: string, word: string): string {
  const at = lower.indexOf(word)
  const start = Math.max(0, at - 60)
  const snippet = text
    .slice(start, at + word.length + 80)
    .replace(/\s+/g, ' ')
    .trim()
  return `contents: "${start > 0 ? '…' : ''}${snippet}…"`
}
