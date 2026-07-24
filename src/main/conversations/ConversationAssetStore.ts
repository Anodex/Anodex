import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import type { ChatImageInput } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'
import type { ToolCallPreview, VisualPreviewContent } from '@shared/tools.types'
import {
  hasExpectedVisionImageSignature,
  MAX_VISION_IMAGE_BYTES,
  visionImageMimeType
} from '../vision/imageInputs'
import { createLogger } from '../utils/logger'

const log = createLogger('conversation-assets')
const SAFE_ID = /^[A-Za-z0-9_-]+$/
const SAFE_ASSET_ID = /^[A-Za-z0-9_-]+\.(?:png|jpg|jpeg|gif|bmp)$/

/** Binary screenshot/image storage kept beside, rather than inside, conversation JSON. */
export class ConversationAssetStore {
  private baseDir = ''

  init(userDataPath: string): void {
    this.baseDir = join(userDataPath, 'conversation-assets')
    this.ensureDir(this.baseDir)
  }

  async saveImage(
    conversationId: string,
    messageId: string,
    image: ChatImageInput
  ): Promise<string> {
    this.assertInitialized()
    assertSafeId(conversationId, 'conversation id')
    assertSafeId(messageId, 'message id')

    const extension = extensionForMimeType(image.mimeType)
    const bytes = decodeImageDataUrl(image)
    if (!hasExpectedVisionImageSignature(`preview.${extension}`, bytes)) {
      throw new Error('Visual preview data is not a valid supported image.')
    }
    const dir = this.dirForConversation(conversationId)
    this.ensureDir(dir)
    const assetId = `${messageId}-${randomUUID()}.${extension}`
    await writeFile(join(dir, assetId), bytes, { flag: 'wx' })
    return assetId
  }

  async readImage(conversationId: string, assetId: string): Promise<VisualPreviewContent> {
    this.assertInitialized()
    assertSafeId(conversationId, 'conversation id')
    assertSafeAssetId(assetId)

    const filePath = join(this.dirForConversation(conversationId), assetId)
    const info = await stat(filePath)
    if (!info.isFile() || info.size <= 0 || info.size > MAX_VISION_IMAGE_BYTES) {
      throw new Error('Stored visual preview has an invalid size.')
    }
    const bytes = await readFile(filePath)
    if (!hasExpectedVisionImageSignature(filePath, bytes)) {
      throw new Error('Stored visual preview is not a valid supported image.')
    }
    const mimeType = visionImageMimeType(filePath)
    if (!mimeType) throw new Error('Stored visual preview has an unsupported format.')
    return {
      dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
      mimeType
    }
  }

  /**
   * Delete assets no longer referenced by the saved transcript. This handles
   * edit-and-regenerate truncation without touching any path outside the
   * validated conversation asset directory.
   */
  pruneConversation(conversation: Conversation): void {
    this.assertInitialized()
    assertSafeId(conversation.id, 'conversation id')
    const dir = this.dirForConversation(conversation.id)
    if (!existsSync(dir)) return

    const keep = collectVisualPreviewAssetIds(conversation)
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && !keep.has(entry.name)) {
          rmSync(join(dir, entry.name))
        }
      }
      if (readdirSync(dir).length === 0) rmdirSync(dir)
    } catch (error) {
      log.warn('Failed to prune visual previews for conversation:', conversation.id, error)
    }
  }

  removeConversation(conversationId: string): void {
    this.assertInitialized()
    assertSafeId(conversationId, 'conversation id')
    const dir = this.dirForConversation(conversationId)
    if (!existsSync(dir)) return
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      log.warn('Failed to remove visual previews for conversation:', conversationId, error)
    }
  }

  private dirForConversation(conversationId: string): string {
    const dir = resolve(this.baseDir, conversationId)
    const expected = resolve(this.baseDir, conversationId)
    if (dir !== expected) throw new Error('Unsafe conversation asset path.')
    return dir
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  private assertInitialized(): void {
    if (!this.baseDir) throw new Error('Conversation asset store is not initialized.')
  }
}

export function collectVisualPreviewAssetIds(conversation: Conversation): Set<string> {
  const ids = new Set<string>()
  for (const message of conversation.messages) {
    for (const call of message.toolCalls ?? [])
      addPreviewAssetId(ids, conversation.id, call.preview)
    for (const block of message.blocks ?? []) {
      if (block.type === 'tool') addPreviewAssetId(ids, conversation.id, block.call.preview)
    }
  }
  return ids
}

function addPreviewAssetId(
  ids: Set<string>,
  conversationId: string,
  preview: ToolCallPreview | undefined
): void {
  if (
    preview?.kind === 'image' &&
    preview.asset?.conversationId === conversationId &&
    SAFE_ASSET_ID.test(preview.asset.id)
  ) {
    ids.add(preview.asset.id)
  }
}

function decodeImageDataUrl(image: ChatImageInput): Buffer {
  const prefix = `data:${image.mimeType};base64,`
  if (!image.dataUrl.startsWith(prefix)) throw new Error('Visual preview data URL is invalid.')
  const bytes = Buffer.from(image.dataUrl.slice(prefix.length), 'base64')
  if (
    bytes.length <= 0 ||
    bytes.length > MAX_VISION_IMAGE_BYTES ||
    bytes.length !== image.sizeBytes
  ) {
    throw new Error('Visual preview data does not match its declared size.')
  }
  return bytes
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/bmp':
      return 'bmp'
    default:
      throw new Error(`Unsupported visual preview MIME type: ${mimeType}`)
  }
}

function assertSafeId(id: string, label: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`Unsafe ${label}: "${id}"`)
}

function assertSafeAssetId(assetId: string): void {
  if (!SAFE_ASSET_ID.test(assetId) || extname(assetId) === '') {
    throw new Error(`Unsafe visual preview asset id: "${assetId}"`)
  }
}

export const conversationAssetStore = new ConversationAssetStore()
