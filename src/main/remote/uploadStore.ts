import { randomUUID } from 'node:crypto'
import { open, mkdir, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { app } from 'electron'
import {
  hasExpectedVisionImageSignature,
  isSupportedVisionImagePath,
  visionImageMimeType
} from '../vision/imageInputs'
import { createLogger } from '../utils/logger'

const log = createLogger('remote:uploads')

/**
 * A hard ceiling on one upload.
 *
 * Not a guess at what people will send: it is what this machine is willing to have
 * written to its disk by something nobody is watching. A phone on a slow uplink
 * gives up on anything near this long before the desktop minds.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/**
 * The most chunks one upload may take.
 *
 * Belt to the size limit's braces. A sender offering empty chunks forever would
 * otherwise hold a slot open without ever tripping the byte ceiling.
 */
export const MAX_UPLOAD_CHUNKS = 2048

/** How long a started-but-abandoned upload keeps its slot and its bytes. */
export const UPLOAD_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** How many uploads may be in flight at once. */
export const MAX_CONCURRENT_UPLOADS = 4

/** Enough of the file to recognise any format we accept by its magic bytes. */
const SIGNATURE_BYTES = 16

/**
 * What a phone may put on this disk.
 *
 * Text and images only. Deliberately no archives, and nothing executable — the
 * point of an attachment is that Anodex reads it, and a format Anodex cannot read
 * is a file that only ever sat on somebody's disk. `.svg` is absent on purpose: it
 * is a document that can carry script, not a picture.
 */
const ALLOWED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.txt',
  '.md',
  '.log',
  '.json',
  '.csv',
  '.yml',
  '.yaml'
])

interface PendingUpload {
  id: string
  /** What the sender called it. Shown; never used to build a path. */
  displayName: string
  extension: string
  declaredBytes: number
  received: number
  chunks: number
  lastTouchedAt: number
  /** Open handle on the `.part` file. Bytes go straight through it. */
  handle: FileHandle
  partPath: string
}

const pending = new Map<string, PendingUpload>()

/**
 * Where uploaded bytes live.
 *
 * Under `userData`, never the workspace. A file arriving from a phone is not part
 * of the project until somebody says so, and writing it straight into a git
 * repository would quietly make it one.
 */
export function uploadDirectory(): string {
  return join(app.getPath('userData'), 'remote-uploads')
}

/**
 * Begin an upload, or refuse it.
 *
 * Everything checkable before a byte arrives is checked here, so a file that was
 * never going to be accepted costs one round trip instead of a whole transfer.
 */
export async function beginUpload(input: {
  name: string
  sizeBytes: number
}): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  await sweepStale()

  if (pending.size >= MAX_CONCURRENT_UPLOADS) {
    return { ok: false, reason: 'Too many uploads at once. Finish one first.' }
  }

  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
    return { ok: false, reason: 'That file is empty.' }
  }

  if (input.sizeBytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: `That file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB.`
    }
  }

  // The declared extension decides only whether to accept the upload at all. It
  // never reaches the filesystem — see `finishUpload`.
  const extension = extname(input.name).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return { ok: false, reason: `Anodex does not take ${extension || 'that kind of'} files.` }
  }

  const id = randomUUID()
  const partPath = join(uploadDirectory(), `${id}.part`)

  try {
    await mkdir(uploadDirectory(), { recursive: true })
    const handle = await open(partPath, 'w')
    pending.set(id, {
      id,
      displayName: safeDisplayName(input.name),
      extension,
      declaredBytes: input.sizeBytes,
      received: 0,
      chunks: 0,
      lastTouchedAt: Date.now(),
      handle,
      partPath
    })
  } catch (error) {
    log.error('Could not open an upload for writing:', error)
    return { ok: false, reason: 'Could not start that upload.' }
  }

  return { ok: true, id }
}

/**
 * Take one chunk of an upload already begun.
 *
 * Written through to the `.part` file as it arrives rather than gathered in memory.
 * Four concurrent uploads at the ceiling would otherwise be 100MB of buffers, and
 * this process has been killed by a large allocation before.
 */
export async function acceptChunk(
  id: string,
  base64: string
): Promise<{ ok: true; received: number } | { ok: false; reason: string }> {
  const upload = pending.get(id)
  if (!upload) return { ok: false, reason: 'That upload is not open.' }

  if (upload.chunks >= MAX_UPLOAD_CHUNKS) {
    await abortUpload(id)
    return { ok: false, reason: 'That upload used too many chunks.' }
  }

  const chunk = Buffer.from(base64, 'base64')

  // Checked as it accumulates, not at the end: the ceiling exists to stop the disk
  // filling, and a check that only runs on completion has already let it fill.
  if (upload.received + chunk.length > upload.declaredBytes) {
    await abortUpload(id)
    return { ok: false, reason: 'That upload sent more than it declared.' }
  }

  try {
    await upload.handle.write(chunk)
  } catch (error) {
    log.error('Could not write an upload chunk:', error)
    await abortUpload(id)
    return { ok: false, reason: 'Could not save that file.' }
  }

  upload.received += chunk.length
  upload.chunks += 1
  upload.lastTouchedAt = Date.now()

  return { ok: true, received: upload.received }
}

/**
 * Close an upload and give it its real name.
 *
 * The finished file only exists once the whole of it has arrived and been checked,
 * which is the rule the design rests on: nothing downstream ever meets a half file,
 * and a message carrying an attachment is not a message until this returns.
 */
export async function finishUpload(
  id: string
): Promise<
  | { ok: true; path: string; name: string; sizeBytes: number; mimeType: string | null }
  | { ok: false; reason: string }
> {
  const upload = pending.get(id)
  if (!upload) return { ok: false, reason: 'That upload is not open.' }

  pending.delete(id)

  try {
    await upload.handle.close()
  } catch {
    // Already closed, or the handle died with the write that failed. Either way the
    // checks below decide the outcome, not this.
  }

  if (upload.received !== upload.declaredBytes) {
    await rm(upload.partPath, { force: true }).catch(() => undefined)
    return { ok: false, reason: 'That upload arrived incomplete.' }
  }

  // The name on disk is ours, built from an id we generated. Nothing the sender
  // chose reaches the filesystem, so no amount of `../` in a filename matters.
  const fileName = `${upload.id}${upload.extension}`
  const target = join(uploadDirectory(), fileName)

  // An image has to actually be one. The extension is a claim; the magic bytes are
  // evidence, and the two disagreeing is the entire reason to look.
  if (isSupportedVisionImagePath(fileName)) {
    const head = await readHead(upload.partPath)
    if (!head || !hasExpectedVisionImageSignature(fileName, head)) {
      await rm(upload.partPath, { force: true }).catch(() => undefined)
      return { ok: false, reason: 'That file is not the kind of image it claims to be.' }
    }
  }

  try {
    await rename(upload.partPath, target)
  } catch (error) {
    log.error('Could not finish an upload:', error)
    await rm(upload.partPath, { force: true }).catch(() => undefined)
    return { ok: false, reason: 'Could not save that file.' }
  }

  log.info(`accepted ${upload.received} bytes as ${fileName}`)

  return {
    ok: true,
    path: target,
    name: upload.displayName,
    sizeBytes: upload.received,
    mimeType: visionImageMimeType(fileName)
  }
}

/** Drop an upload and its bytes. Safe for an id that is already gone. */
export async function abortUpload(id: string): Promise<void> {
  const upload = pending.get(id)
  if (!upload) return

  pending.delete(id)
  await upload.handle.close().catch(() => undefined)
  await rm(upload.partPath, { force: true }).catch(() => undefined)
}

/** Forget every upload in flight — for when the client that started them goes away. */
export async function abortAllUploads(): Promise<void> {
  await Promise.all([...pending.keys()].map(abortUpload))
}

/**
 * Delete an accepted upload's file.
 *
 * For a message carrying it that never gets sent. Without this the directory only
 * ever grows, and it grows with things somebody changed their mind about.
 */
export async function discardUpload(path: string): Promise<void> {
  // Only ever inside our own directory, and only ever a name we generated.
  if (!path.startsWith(uploadDirectory())) return
  await rm(path, { force: true }).catch(() => undefined)
}

/** How many uploads are open. For tests and diagnostics. */
export function pendingUploadCount(): number {
  return pending.size
}

async function readHead(path: string): Promise<Buffer | null> {
  try {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(SIGNATURE_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, SIGNATURE_BYTES, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/**
 * A display name with nothing awkward in it.
 *
 * This never becomes a path, so it is about what gets rendered rather than what
 * gets written. A name carrying control characters or separators can still make a
 * mess of a list, and there is no reason to keep them.
 */
export function safeDisplayName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = name.replace(/[\u0000-\u001f\u007f]/g, '')

  return stripped.replace(/[/\\]/g, ' ').trim().slice(0, 120) || 'Attachment'
}

/** Release slots and bytes held by uploads nobody finished. */
async function sweepStale(): Promise<void> {
  const cutoff = Date.now() - UPLOAD_IDLE_TIMEOUT_MS
  const stale = [...pending.values()].filter((upload) => upload.lastTouchedAt < cutoff)
  await Promise.all(stale.map((upload) => abortUpload(upload.id)))
}

/** For tests: how large an accepted upload actually is on disk. */
export async function uploadSizeOnDisk(path: string): Promise<number> {
  return (await stat(path)).size
}
