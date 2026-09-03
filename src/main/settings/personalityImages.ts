import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, dialog } from 'electron'

/**
 * Pictures for assistant personalities, kept as files on disk.
 *
 * The alternative was base64 in `settings.json`, and that file is read on every
 * `get()` — a few hundred KB per personality would be paid for on every read
 * the app makes, forever. So the user picks a file, it is copied into
 * `userData/personality-images/`, and the record holds the path.
 *
 * Copied rather than referenced in place: a picture that lives in Downloads
 * disappears the first time that folder is tidied, and the personality would
 * silently lose its face.
 */

/** Formats a renderer `<img>` can display without conversion. */
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/**
 * Generous for a portrait, small enough that a stray 40MB TIFF export cannot
 * be copied into the app's own data directory by accident.
 */
export const MAX_PERSONALITY_IMAGE_BYTES = 8 * 1024 * 1024

function imagesDir(): string {
  return join(app.getPath('userData'), 'personality-images')
}

/**
 * Ask for a picture and copy it in. Returns the stored path, or `null` when
 * the user cancels — cancelling is not an error and must not surface as one.
 */
export async function pickPersonalityImage(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Choose a picture',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  })
  const source = result.filePaths[0]
  if (result.canceled || !source) return null

  const extension = extname(source).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error('Pick a PNG, JPEG, WebP or GIF image.')
  }
  const info = await stat(source)
  if (info.size > MAX_PERSONALITY_IMAGE_BYTES) {
    throw new Error('That image is larger than 8 MB. Pick a smaller one.')
  }

  const dir = imagesDir()
  await mkdir(dir, { recursive: true })
  const destination = join(dir, `${randomUUID()}${extension}`)
  await copyFile(source, destination)
  return destination
}

/**
 * Delete a stored picture, if it is one of ours.
 *
 * The path check is the whole point: this is reachable from the renderer, and
 * an unchecked delete taking any absolute path would be a way to remove
 * arbitrary files. A path outside the store is ignored rather than rejected —
 * it means the personality referenced something we never copied, and there is
 * nothing of ours to clean up.
 */
export async function forgetPersonalityImage(path: string): Promise<void> {
  const dir = imagesDir()
  if (!path.startsWith(dir + '\\') && !path.startsWith(dir + '/')) return
  await rm(path, { force: true })
}
