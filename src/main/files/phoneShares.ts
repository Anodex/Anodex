import { copyFile, readFile, stat } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ATTACHMENT_CHUNK_BYTES, type AttachmentChunk } from '../email/attachmentChunks'

/**
 * Files sent to the person's phone, held on this computer until the phone saves
 * them.
 *
 * "Send it to my phone" used to mean email, and email is not set up by default,
 * so for most people it meant nothing. A paired phone is already connected to
 * this computer; this is the shelf it collects from.
 *
 * A copy, not a pointer: the file the person sent is the one that arrives, even
 * if the original is edited or moved before the phone fetches it. Bounded three
 * ways so a shelf nobody empties cannot grow: one file, the whole shelf, and how
 * long anything waits.
 */
export interface PhoneShare {
  id: string
  name: string
  size: number
  mimeType: string
  sentAt: number
}

/** What a phone advertises, and this computer too, when they can pass files this way. */
export const FILES_CAPABILITY = 'files.1'

export const MAX_SHARE_BYTES = 100 * 1024 * 1024
export const MAX_SHELF_BYTES = 500 * 1024 * 1024
export const SHARE_KEEP_MS = 7 * 24 * 60 * 60 * 1000

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip'
}

/** A file's media type by its extension, or the generic one. */
export function mimeTypeFor(name: string): string {
  return MIME_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

export class PhoneShareStore {
  constructor(private readonly dir: string) {}

  private get indexPath(): string {
    return join(this.dir, 'index.json')
  }

  private fileOf(id: string): string {
    return join(this.dir, id)
  }

  /** What is on the shelf, minus anything expired or whose copy has gone. */
  private read(now: number): PhoneShare[] {
    if (!existsSync(this.indexPath)) return []
    let entries: PhoneShare[]
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.indexPath, 'utf8'))
      entries = Array.isArray(parsed) ? (parsed as PhoneShare[]) : []
    } catch {
      return []
    }
    return entries.filter((entry) => {
      const keep =
        typeof entry?.id === 'string' &&
        now - entry.sentAt < SHARE_KEEP_MS &&
        existsSync(this.fileOf(entry.id))
      if (!keep && typeof entry?.id === 'string') rmSync(this.fileOf(entry.id), { force: true })
      return keep
    })
  }

  private write(entries: PhoneShare[]): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.indexPath, JSON.stringify(entries))
  }

  /** Put a copy of a file on the shelf, making room by letting the oldest go. */
  async add(path: string, now = Date.now()): Promise<PhoneShare> {
    const stats = await stat(path)
    if (!stats.isFile()) throw new Error(`${basename(path)} is not a file.`)
    if (stats.size > MAX_SHARE_BYTES) {
      throw new Error(`${basename(path)} is too big to send to the phone (the limit is 100 MB).`)
    }
    mkdirSync(this.dir, { recursive: true })
    const share: PhoneShare = {
      id: randomUUID(),
      name: basename(path),
      size: stats.size,
      mimeType: mimeTypeFor(path),
      sentAt: now
    }
    await copyFile(path, this.fileOf(share.id))

    const kept: PhoneShare[] = [share]
    let total = share.size
    for (const entry of this.read(now).sort((a, b) => b.sentAt - a.sentAt)) {
      if (total + entry.size > MAX_SHELF_BYTES) {
        rmSync(this.fileOf(entry.id), { force: true })
        continue
      }
      kept.push(entry)
      total += entry.size
    }
    this.write(kept)
    return share
  }

  /** Newest first, as the phone lists them. */
  list(now = Date.now()): PhoneShare[] {
    const entries = this.read(now)
    this.write(entries)
    return entries.sort((a, b) => b.sentAt - a.sentAt)
  }

  /** One chunk of a shared file, or null when it is not on the shelf. */
  async chunk(id: string, offset: number, now = Date.now()): Promise<AttachmentChunk | null> {
    const share = this.read(now).find((entry) => entry.id === id)
    if (!share) return null
    const data = await readFile(this.fileOf(share.id))
    const start = Math.max(0, Math.min(Math.floor(offset) || 0, data.length))
    const end = Math.min(start + ATTACHMENT_CHUNK_BYTES, data.length)
    return {
      filename: share.name,
      mimeType: share.mimeType,
      size: data.length,
      offset: start,
      base64: data.subarray(start, end).toString('base64'),
      done: end >= data.length
    }
  }

  /** Take a file off the shelf, once the phone has it. */
  remove(id: string, now = Date.now()): void {
    const entries = this.read(now)
    rmSync(this.fileOf(id), { force: true })
    this.write(entries.filter((entry) => entry.id !== id))
  }
}

let store: PhoneShareStore | null = null

/** The shelf in this install's user data, made on first use. */
export async function phoneShares(): Promise<PhoneShareStore> {
  if (!store) {
    // Read when needed: this module is imported by tools that load in tests.
    const { app } = await import('electron')
    store = new PhoneShareStore(join(app.getPath('userData'), 'phone-shares'))
  }
  return store
}
