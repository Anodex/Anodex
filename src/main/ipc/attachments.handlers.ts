import { basename, extname } from 'node:path'
import { stat, readFile } from 'node:fs/promises'
import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron'
import { IpcChannel } from '@shared/ipc'
import {
  abortUpload,
  acceptChunk,
  beginUpload,
  discardUpload,
  finishUpload
} from '../remote/uploadStore'
import { ok, err, toErrorMessage, type Result } from '@shared/result'
import type { AttachmentContent } from '@shared/chat.types'
import {
  hasExpectedVisionImageSignature,
  isSupportedVisionImagePath,
  MAX_VISION_IMAGE_BYTES,
  visionImageMimeType
} from '../vision/imageInputs'

/** Matches the old read_file tool cap — enough for real source files, small enough to keep a
 *  single dropped file from dominating a turn's context. */
const MAX_ATTACHMENT_BYTES = 60 * 1024
/** Bound IPC/base64 overhead and vision preprocessing for one user-selected image. */
/** How many leading bytes to sniff for a NUL byte when deciding if a file is binary. */
const BINARY_SNIFF_BYTES = 8000

const UNSUPPORTED_IMAGE_EXTENSIONS = new Set(['.webp', '.ico', '.tiff', '.avif'])

/** True if `path`'s extension is a common raster image format. */
export function isImagePath(path: string): boolean {
  return isSupportedVisionImagePath(path)
}

/** MIME type used by llama-server's OpenAI-compatible image content part. */
export function imageMimeType(path: string): string {
  const visionMimeType = visionImageMimeType(path)
  if (visionMimeType) return visionMimeType
  switch (extname(path).toLowerCase()) {
    case '.tiff':
      return 'image/tiff'
    case '.avif':
      return 'image/avif'
    case '.ico':
      return 'image/x-icon'
    default:
      return 'application/octet-stream'
  }
}

/** Verify that an image extension agrees with its file signature before forwarding bytes. */
export function hasExpectedImageSignature(path: string, buffer: Buffer): boolean {
  return hasExpectedVisionImageSignature(path, buffer)
}

/**
 * True if `buffer` looks like binary (non-text) data — a NUL byte anywhere in
 * a real text file is vanishingly rare, but universal in binary formats
 * (images, archives, executables). Same heuristic git and most editors use.
 */
export function isLikelyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, BINARY_SNIFF_BYTES))
  return sample.includes(0)
}

async function pickFiles(event: IpcMainInvokeEvent): Promise<{ path: string; name: string }[]> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const options: OpenDialogOptions = {
    title: 'Attach files',
    properties: ['openFile', 'multiSelections']
  }
  const picked = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  if (picked.canceled) return []
  return picked.filePaths.map((path) => ({ path, name: basename(path) }))
}

async function pickImage(
  event: IpcMainInvokeEvent
): Promise<{ path: string; name: string } | null> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const options: OpenDialogOptions = {
    title: 'Locate image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp'] }]
  }
  const picked = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  const path = picked.canceled ? undefined : picked.filePaths[0]
  return path ? { path, name: basename(path) } : null
}

/**
 * Read a file the user chose to attach, by absolute path: a bounded data URL for a
 * supported image, bounded text for anything else, and a refusal for binary data.
 *
 * Shared by the chat composer's IPC read and by agent runs, which validate and
 * re-read their own copies with it — one definition of what an attachment may be.
 */
export async function readAttachmentFile(absolutePath: string): Promise<Result<AttachmentContent>> {
  try {
    const info = await stat(absolutePath)
    if (!info.isFile()) return err('attachments.not-a-file', 'That is not a file.')

    if (isImagePath(absolutePath)) {
      if (info.size > MAX_VISION_IMAGE_BYTES) {
        return err(
          'attachments.image-too-large',
          'That image is too large. Choose an image smaller than 15 MB.'
        )
      }
      const buffer = await readFile(absolutePath)
      if (!hasExpectedImageSignature(absolutePath, buffer)) {
        return err(
          'attachments.invalid-image',
          'That file does not contain a valid supported image.'
        )
      }
      const mimeType = imageMimeType(absolutePath)
      return ok({
        kind: 'image' as const,
        dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
        mimeType,
        sizeBytes: info.size,
        truncated: false as const
      })
    }
    if (UNSUPPORTED_IMAGE_EXTENSIONS.has(extname(absolutePath).toLowerCase())) {
      return err(
        'attachments.image-format-unsupported',
        'Local vision accepts PNG, JPEG, GIF, or BMP images. Convert this image and try again.'
      )
    }

    const buffer = await readFile(absolutePath)
    if (isLikelyBinary(buffer)) {
      return err(
        'attachments.binary-file',
        'That looks like a binary file, not text — only text/code files can be attached.'
      )
    }

    const raw = buffer.toString('utf-8')
    const truncated = raw.length > MAX_ATTACHMENT_BYTES
    const content = truncated ? raw.slice(0, MAX_ATTACHMENT_BYTES) : raw
    return ok({ kind: 'text' as const, content, sizeBytes: info.size, truncated })
  } catch (error) {
    return err('attachments.read-failed', 'Could not read that file.', toErrorMessage(error))
  }
}

/**
 * IPC handler for reading a file the user dropped/dragged into the chat composer.
 *
 * Deliberately does NOT go through `resolveInWorkspace` — unlike every AI tool call, this is a
 * file the user explicitly chose (OS drag-drop, or dragging a row from the Files panel), so the
 * workspace sandbox that protects against the *model* wandering outside the project doesn't apply
 * here. The path can be anywhere on disk the user has access to.
 *
 * Supported raster images are returned as bounded data URLs for the active vision provider. Other
 * binary files are still rejected instead of being decoded as UTF-8 and injected as prompt noise.
 */
export function registerAttachmentHandlers(): void {
  ipcMain.handle(IpcChannel.Attachments.pickFiles, (event) => pickFiles(event))
  ipcMain.handle(IpcChannel.Attachments.pickImage, (event) => pickImage(event))

  ipcMain.handle(IpcChannel.Attachments.readFile, (_event, absolutePath: string) =>
    readAttachmentFile(absolutePath)
  )

  registerUploadHandlers()
}

/**
 * Taking a file from a paired phone.
 *
 * Four steps rather than one call with the bytes in it: a frame is capped at 256KB
 * and a file worth attaching is bigger than that, so it arrives in pieces. The split
 * also lets the desktop refuse a file before a single byte is sent — a name and a
 * size are enough to know that a 40MB `.zip` is not going to be accepted.
 *
 * Every rule about what is allowed lives in `uploadStore`, not here. This is the
 * doorway; the checks are the room.
 */
function registerUploadHandlers(): void {
  ipcMain.handle(
    IpcChannel.Attachments.beginUpload,
    async (_event, input: { name: string; sizeBytes: number }) => {
      const started = await beginUpload({
        name: String(input?.name ?? ''),
        sizeBytes: Number(input?.sizeBytes ?? 0)
      })

      return started.ok ? ok({ id: started.id }) : err('attachments.upload-refused', started.reason)
    }
  )

  ipcMain.handle(
    IpcChannel.Attachments.uploadChunk,
    async (_event, input: { id: string; data: string }) => {
      const taken = await acceptChunk(String(input?.id ?? ''), String(input?.data ?? ''))

      return taken.ok
        ? ok({ received: taken.received })
        : err('attachments.upload-failed', taken.reason)
    }
  )

  ipcMain.handle(IpcChannel.Attachments.completeUpload, async (_event, input: { id: string }) => {
    const done = await finishUpload(String(input?.id ?? ''))
    if (!done.ok) return err('attachments.upload-failed', done.reason)

    // Shaped as the renderer's own attachment, so a file from a phone is the same
    // kind of thing as one dropped on the window and nothing downstream has to
    // know where it came from.
    return ok({
      path: done.path,
      name: done.name,
      sizeBytes: done.sizeBytes,
      kind: done.mimeType ? ('image' as const) : ('text' as const),
      ...(done.mimeType ? { mimeType: done.mimeType } : {})
    })
  })

  ipcMain.handle(IpcChannel.Attachments.abortUpload, async (_event, input: { id: string }) => {
    await abortUpload(String(input?.id ?? ''))
    return ok(null)
  })

  ipcMain.handle(IpcChannel.Attachments.discardUpload, async (_event, path: string) => {
    await discardUpload(String(path ?? ''))
    return ok(null)
  })
}
