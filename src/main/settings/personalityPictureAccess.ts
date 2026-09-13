import { basename, relative, isAbsolute } from 'node:path'

/**
 * What a paired phone may know about a personality's picture, and which files it
 * may ask for.
 *
 * Pure, and apart from `personalityImages.ts`, so it can be tested without Electron.
 */

/**
 * A key that names the picture without revealing where it lives.
 *
 * The stored path is the desktop's own disk layout — a user profile directory in
 * plain text — and none of it is the phone's business. The file name alone is a
 * random UUID chosen when the picture was copied in, so it changes exactly when the
 * picture does, which is all a cache on the other end needs to know.
 */
export function personalityPictureKey(image: string | undefined): string | null {
  if (!image) return null
  return basename(image) || null
}

/**
 * Whether a stored path is inside the app's own picture store.
 *
 * `image` is a setting, and settings can be edited by hand or restored from a
 * backup. Without this, a personality pointed at `C:\Users\me\.ssh\id_ed25519`
 * would make `personality:image` a way to read any file the desktop can — from a
 * phone. Only files this app copied in are ever served.
 */
export function isStoredPersonalityPicture(image: string, storeDir: string): boolean {
  const rel = relative(storeDir, image)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Long edge of the picture sent to a phone, in pixels.
 *
 * It is drawn at 22–48dp. The original may be 8 MB, and a socket message that size
 * per personality would be paid on a phone connection for a thumbnail.
 */
export const REMOTE_PERSONALITY_PICTURE_EDGE = 192
