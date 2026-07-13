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
import { ok, err, toErrorMessage } from '@shared/result'

/** Matches the old read_file tool cap — enough for real source files, small enough to keep a
 *  single dropped file from dominating a turn's context. */
const MAX_ATTACHMENT_BYTES = 60 * 1024

/** How many leading bytes to sniff for a NUL byte when deciding if a file is binary. */
const BINARY_SNIFF_BYTES = 8000

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.ico',
  '.tiff',
  '.avif'
])

/** True if `path`'s extension is a common raster image format. */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase())
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
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (picked.canceled) return []
  return picked.filePaths.map((path) => ({ path, name: basename(path) }))
}

/**
 * IPC handler for reading a file the user dropped/dragged into the chat composer.
 *
 * Deliberately does NOT go through `resolveInWorkspace` — unlike every AI tool call, this is a
 * file the user explicitly chose (OS drag-drop, or dragging a row from the Files panel), so the
 * workspace sandbox that protects against the *model* wandering outside the project doesn't apply
 * here. The path can be anywhere on disk the user has access to.
 *
 * Refuses images and other binary files outright rather than reading them as UTF-8 — Anodex's
 * local engine (node-llama-cpp) has no vision/multimodal support, so silently "reading" an image
 * would just inject garbled binary-as-text noise into the prompt instead of failing clearly.
 */
export function registerAttachmentHandlers(): void {
  ipcMain.handle(IpcChannel.Attachments.pickFiles, (event) => pickFiles(event))

  ipcMain.handle(IpcChannel.Attachments.readFile, async (_event, absolutePath: string) => {
    try {
      const info = await stat(absolutePath)
      if (!info.isFile()) return err('attachments.not-a-file', 'That is not a file.')

      if (isImagePath(absolutePath)) {
        return err(
          'attachments.image-unsupported',
          "Anodex can't read image content yet — the local model has no vision support."
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
      return ok({ content, sizeBytes: info.size, truncated })
    } catch (error) {
      return err('attachments.read-failed', 'Could not read that file.', toErrorMessage(error))
    }
  })
}
