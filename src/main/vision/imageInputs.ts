import { extname } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import type { ChatAttachment, ChatHistoryTurn, ChatImageInput } from '@shared/chat.types'

/** Bound image decoding, IPC payloads, and provider requests to a predictable size. */
export const MAX_VISION_IMAGE_BYTES = 15 * 1024 * 1024
/** One user turn or visual tool loop may expose at most this many images to a model. */
export const MAX_VISION_IMAGES = 4
export const CLOUD_VISION_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
])
/**
 * What the local llama.cpp transport can decode. Deliberately not the same set
 * as the cloud one: llama.cpp decodes with stb_image, which handles BMP but not
 * WebP. Workspace inspection never produced either mismatch (its extension
 * allow-list stops at BMP), but an email attachment is whatever the sender
 * chose, so the local queue needs a real gate rather than an assumption.
 */
export const LOCAL_VISION_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/bmp'
])

const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp'])
const SUPPORTED_DATA_URL = /^data:image\/(?:png|jpeg|gif|bmp|webp);base64,/i

/** True for raster formats accepted by the local llama.cpp vision transport. */
export function isSupportedVisionImagePath(path: string): boolean {
  return SUPPORTED_IMAGE_EXTENSIONS.has(extname(path).toLowerCase())
}

/** MIME type used by multimodal provider content blocks. */
export function visionImageMimeType(path: string): string | null {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.bmp':
      return 'image/bmp'
    case '.webp':
      return 'image/webp'
    default:
      return null
  }
}

/** Verify that a supported extension agrees with the file's leading signature bytes. */
export function hasExpectedVisionImageSignature(path: string, buffer: Buffer): boolean {
  // The extension allow-list stays authoritative for file-backed images, so a
  // `.webp` on disk is still refused here exactly as it was before this check
  // learned to work from MIME types too.
  if (!isSupportedVisionImagePath(path)) return false
  const mimeType = visionImageMimeType(path)
  return mimeType ? matchesVisionImageSignature(mimeType, buffer) : false
}

/**
 * Verify bytes against the format their MIME type claims.
 *
 * The path-based check above cannot serve content that never touches disk — an
 * email attachment arrives as a buffer plus a sender-supplied MIME type, and a
 * sender-supplied type is a claim, not evidence. Checking the leading bytes is
 * what keeps "image/png" from being an arbitrary payload handed to a decoder.
 */
export function matchesVisionImageSignature(mimeType: string, buffer: Buffer): boolean {
  switch (mimeType.toLowerCase()) {
    case 'image/png':
      return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    case 'image/jpeg':
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    case 'image/gif': {
      const signature = buffer.subarray(0, 6).toString('ascii')
      return signature === 'GIF87a' || signature === 'GIF89a'
    }
    case 'image/bmp':
      return buffer.subarray(0, 2).toString('ascii') === 'BM'
    case 'image/webp':
      return (
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP'
      )
    default:
      return false
  }
}

/** Validate a renderer/tool supplied ephemeral image before it enters a provider request. */
export function isValidVisionImageInput(image: ChatImageInput): boolean {
  return (
    image.sizeBytes > 0 &&
    image.sizeBytes <= MAX_VISION_IMAGE_BYTES &&
    image.dataUrl.length <= Math.ceil((MAX_VISION_IMAGE_BYTES * 4) / 3) + 256 &&
    SUPPORTED_DATA_URL.test(image.dataUrl)
  )
}

/** Read and validate an image file chosen by a model-visible workspace tool. */
export async function readVisionImage(path: string, name: string): Promise<ChatImageInput> {
  const mimeType = visionImageMimeType(path)
  if (!mimeType || !isSupportedVisionImagePath(path)) {
    throw new Error('Visual inspection supports PNG, JPEG, GIF, or BMP image files.')
  }

  const info = await stat(path)
  if (!info.isFile()) throw new Error('Path is not a file.')
  if (info.size <= 0 || info.size > MAX_VISION_IMAGE_BYTES) {
    throw new Error('Image must be larger than 0 bytes and smaller than 15 MB.')
  }

  const data = await readFile(path)
  if (!hasExpectedVisionImageSignature(path, data)) {
    throw new Error('The file does not contain a valid supported image.')
  }
  return {
    path,
    name,
    mimeType,
    sizeBytes: info.size,
    dataUrl: `data:${mimeType};base64,${data.toString('base64')}`
  }
}

/**
 * Validate image bytes that never touched the filesystem — today, an email
 * attachment fetched straight from a provider.
 *
 * `reference` fills `ChatImageInput.path`, which for this source is a label
 * rather than a location: nothing reads it back off disk (providers use
 * `dataUrl` alone), and deliberately keeping it non-path-shaped means no later
 * caller can mistake it for something readable.
 */
export function readVisionImageBuffer(
  data: Buffer,
  options: { name: string; mimeType: string; reference: string }
): ChatImageInput {
  const mimeType = options.mimeType.toLowerCase()
  if (!VISION_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(
      `"${options.name}" is ${options.mimeType || 'an unknown type'}, which cannot be viewed as an image. Supported: PNG, JPEG, GIF, BMP, WebP.`
    )
  }
  if (data.length <= 0 || data.length > MAX_VISION_IMAGE_BYTES) {
    throw new Error(`"${options.name}" must be larger than 0 bytes and smaller than 15 MB.`)
  }
  if (!matchesVisionImageSignature(mimeType, data)) {
    throw new Error(`"${options.name}" does not contain valid ${options.mimeType} image data.`)
  }
  return {
    path: options.reference,
    name: options.name,
    mimeType,
    sizeBytes: data.length,
    dataUrl: `data:${mimeType};base64,${data.toString('base64')}`
  }
}

/** Every raster type any provider here can accept; the queue narrows per provider. */
const VISION_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/bmp',
  'image/webp'
])

/** True for a MIME type worth offering to a vision model at all. */
export function isVisionImageMimeType(mimeType: string): boolean {
  return VISION_IMAGE_MIME_TYPES.has(mimeType.toLowerCase())
}

/** Reopen persisted attachment metadata without ever persisting its image bytes. */
export async function reopenChatImage(attachment: ChatAttachment): Promise<ChatImageInput | null> {
  try {
    const info = await stat(attachment.path)
    if (
      !info.isFile() ||
      info.size !== attachment.sizeBytes ||
      info.size <= 0 ||
      info.size > MAX_VISION_IMAGE_BYTES
    ) {
      return null
    }
    const mimeType = attachment.mimeType || visionImageMimeType(attachment.path)
    if (!mimeType) return null
    const data = await readFile(attachment.path)
    const image = {
      path: attachment.path,
      name: attachment.name,
      mimeType,
      sizeBytes: info.size,
      dataUrl: `data:${mimeType};base64,${data.toString('base64')}`
    }
    return isValidVisionImageInput(image) ? image : null
  } catch {
    return null
  }
}

/** Keep valid current-turn images first; they are the user's immediate request. */
export function selectCurrentVisionImages(
  images: readonly ChatImageInput[] | undefined
): ChatImageInput[] {
  return (images ?? []).filter(isValidVisionImageInput).slice(0, MAX_VISION_IMAGES)
}

/**
 * Reopen the newest available historical images up to `limit`, returning them
 * keyed by their original turn index so providers can preserve chronology.
 */
export async function reopenRecentHistoryImages(
  history: readonly ChatHistoryTurn[],
  limit: number
): Promise<Map<number, ChatImageInput[]>> {
  const selected = new Map<number, ChatImageInput[]>()
  let remaining = Math.max(0, limit)
  for (let turnIndex = history.length - 1; turnIndex >= 0 && remaining > 0; turnIndex--) {
    const turn = history[turnIndex]
    if (turn.role !== 'user') continue
    const attachments = turn.attachments ?? []
    for (
      let attachmentIndex = attachments.length - 1;
      attachmentIndex >= 0 && remaining > 0;
      attachmentIndex--
    ) {
      const attachment = attachments[attachmentIndex]
      if (attachment.kind !== 'image') continue
      const image = await reopenChatImage(attachment)
      if (!image) continue
      const turnImages = selected.get(turnIndex) ?? []
      turnImages.unshift(image)
      selected.set(turnIndex, turnImages)
      remaining -= 1
    }
  }
  return selected
}

/** Cloud APIs accept the same common formats except BMP. Fail clearly before a paid request. */
export function assertCloudVisionCompatible(images: readonly ChatImageInput[]): void {
  const bmp = images.find((image) => image.mimeType.toLowerCase() === 'image/bmp')
  if (bmp) {
    throw new Error(
      `Cloud vision cannot send BMP files. Convert "${bmp.name}" to PNG or JPEG and try again.`
    )
  }
}

/** Mutable, per-generation bridge from visual workspace tools into the provider's next round. */
export interface VisualInputQueue {
  current: ChatImageInput[]
  acceptedCount: number
  limit: number
  acceptedMimeTypes?: ReadonlySet<string>
}

export function createVisualInputQueue(
  limit = MAX_VISION_IMAGES,
  acceptedMimeTypes?: ReadonlySet<string>
): VisualInputQueue {
  return { current: [], acceptedCount: 0, limit, acceptedMimeTypes }
}

export function enqueueVisualInput(queue: VisualInputQueue, image: ChatImageInput): void {
  if (queue.acceptedMimeTypes && !queue.acceptedMimeTypes.has(image.mimeType.toLowerCase())) {
    throw new Error(
      `The active provider cannot inspect ${image.mimeType} images. Convert "${image.name}" to PNG or JPEG and try again.`
    )
  }
  if (queue.acceptedCount >= queue.limit) {
    throw new Error(
      `Visual inspection limit reached (${queue.limit} images per response). Summarize what you saw before continuing in a new message.`
    )
  }
  queue.current.push(image)
  queue.acceptedCount += 1
}

export function drainVisualInputs(queue: VisualInputQueue): ChatImageInput[] {
  return queue.current.splice(0, queue.current.length)
}
