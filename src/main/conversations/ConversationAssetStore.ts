import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { ChatImageInput } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'
import type { ToolCallPreview, VisualPreviewContent } from '@shared/tools.types'
import type {
  VisualPreviewClearResult,
  VisualPreviewStorageUsage
} from '@shared/visualPreview.types'
import {
  hasExpectedVisionImageSignature,
  MAX_VISION_IMAGE_BYTES,
  visionImageMimeType
} from '../vision/imageInputs'
import { createLogger } from '../utils/logger'

const log = createLogger('conversation-assets')
const SAFE_ID = /^[A-Za-z0-9_-]+$/
const SAFE_ASSET_ID = /^[A-Za-z0-9_-]+\.(?:png|jpg|jpeg|gif|bmp)$/
export const MAX_VISUAL_PREVIEW_STORAGE_BYTES = 256 * 1024 * 1024
export const MAX_CONVERSATION_PREVIEW_STORAGE_BYTES = 64 * 1024 * 1024

interface ConversationAssetStoreLimits {
  totalBytes: number
  conversationBytes: number
}

interface StoredAsset {
  path: string
  conversationId: string
  sizeBytes: number
  modifiedAt: number
}

/** Binary screenshot/image storage kept beside, rather than inside, conversation JSON. */
export class ConversationAssetStore {
  private baseDir = ''
  private readonly limits: ConversationAssetStoreLimits

  constructor(limits: Partial<ConversationAssetStoreLimits> = {}) {
    this.limits = {
      totalBytes: limits.totalBytes ?? MAX_VISUAL_PREVIEW_STORAGE_BYTES,
      conversationBytes: limits.conversationBytes ?? MAX_CONVERSATION_PREVIEW_STORAGE_BYTES
    }
  }

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
    assertSafeId(messageId, 'message id')

    const extension = extensionForMimeType(image.mimeType)
    const bytes = decodeImageDataUrl(image)
    if (!hasExpectedVisionImageSignature(`preview.${extension}`, bytes)) {
      throw new Error('Visual preview data is not a valid supported image.')
    }
    const dir = this.dirForConversation(conversationId)
    this.ensureDir(dir)
    const assetId = `${messageId}-${randomUUID()}.${extension}`
    const assetPath = join(dir, assetId)
    await writeFile(assetPath, bytes, { flag: 'wx' })
    await this.enforceLimits(conversationId, assetPath)
    return assetId
  }

  async readImage(conversationId: string, assetId: string): Promise<VisualPreviewContent> {
    this.assertInitialized()
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
    const dir = this.dirForConversation(conversationId)
    if (!existsSync(dir)) return
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      log.warn('Failed to remove visual previews for conversation:', conversationId, error)
    }
  }

  async getUsage(): Promise<VisualPreviewStorageUsage> {
    this.assertInitialized()
    const assets = await this.listAssets()
    return {
      totalBytes: assets.reduce((total, asset) => total + asset.sizeBytes, 0),
      fileCount: assets.length,
      conversationCount: new Set(assets.map((asset) => asset.conversationId)).size,
      limitBytes: this.limits.totalBytes,
      conversationLimitBytes: this.limits.conversationBytes
    }
  }

  async clearAll(): Promise<VisualPreviewClearResult> {
    this.assertInitialized()
    const usage = await this.getUsage()
    await rm(this.baseDir, { recursive: true, force: true })
    this.ensureDir(this.baseDir)
    return { removedBytes: usage.totalBytes, removedFiles: usage.fileCount }
  }

  private async enforceLimits(conversationId: string, protectedPath: string): Promise<void> {
    const assets = await this.listAssets()
    await removeOldestOverLimit(
      assets.filter((asset) => asset.conversationId === conversationId),
      this.limits.conversationBytes,
      protectedPath
    )
    await removeOldestOverLimit(await this.listAssets(), this.limits.totalBytes, protectedPath)
  }

  private async listAssets(): Promise<StoredAsset[]> {
    const assets: StoredAsset[] = []
    let conversations
    try {
      conversations = await readdir(this.baseDir, { withFileTypes: true })
    } catch {
      return assets
    }
    for (const conversation of conversations) {
      if (!conversation.isDirectory() || !SAFE_ID.test(conversation.name)) continue
      const dir = join(this.baseDir, conversation.name)
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || !SAFE_ASSET_ID.test(entry.name)) continue
        const path = join(dir, entry.name)
        try {
          const info = await stat(path)
          assets.push({
            path,
            conversationId: conversation.name,
            sizeBytes: info.size,
            modifiedAt: info.mtimeMs
          })
        } catch {
          // A concurrent clear/prune already removed it.
        }
      }
    }
    return assets
  }

  /**
   * The one place a conversation id becomes a directory path, and therefore
   * the right place to decide whether it may.
   *
   * This used to compare `resolve(baseDir, id)` against `resolve(baseDir, id)`
   * — the same expression twice, so the guard it looks like could never fire.
   * Nothing escaped through it, because all four callers validated the id
   * themselves first; the check simply was not the thing keeping them safe.
   * Validating here instead makes it load-bearing, so a method added later is
   * confined whether or not its author remembers to ask.
   */
  private dirForConversation(conversationId: string): string {
    assertSafeId(conversationId, 'conversation id')
    const base = resolve(this.baseDir)
    const dir = resolve(base, conversationId)
    if (dir === base || !dir.startsWith(`${base}${sep}`)) {
      throw new Error('Unsafe conversation asset path.')
    }
    return dir
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  private assertInitialized(): void {
    if (!this.baseDir) throw new Error('Conversation asset store is not initialized.')
  }
}

async function removeOldestOverLimit(
  assets: StoredAsset[],
  limitBytes: number,
  protectedPath: string
): Promise<void> {
  let total = assets.reduce((sum, asset) => sum + asset.sizeBytes, 0)
  if (total <= limitBytes) return
  const oldest = [...assets].sort(
    (left, right) => left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path)
  )
  for (const asset of oldest) {
    if (total <= limitBytes) break
    if (asset.path === protectedPath) continue
    try {
      await rm(asset.path, { force: true })
      total -= asset.sizeBytes
    } catch {
      // Best effort: a concurrent cleanup may already own this file.
    }
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
  // `SAFE_ASSET_ID` already requires one of the supported extensions, so the
  // `extname(assetId) === ''` half this also tested could never reject
  // anything the pattern had accepted.
  if (!SAFE_ASSET_ID.test(assetId)) {
    throw new Error(`Unsafe visual preview asset id: "${assetId}"`)
  }
}

export const conversationAssetStore = new ConversationAssetStore()
