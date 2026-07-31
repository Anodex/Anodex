import type { ChatImageInput } from '@shared/chat.types'
import type { VisualPreviewAssetRef } from '@shared/tools.types'
import type { ToolRuntimeContext } from './types'
import { conversationAssetStore } from '../conversations/ConversationAssetStore'
import { createLogger } from '../utils/logger'

const log = createLogger('visual-preview-assets')

/**
 * Persist preview pixels separately from conversation JSON when storage is
 * available. Scoped to the conversation, not the workspace — an email
 * attachment is inspected in chats that have no workspace at all.
 */
export async function saveVisualPreviewAsset(
  ctx: ToolRuntimeContext,
  image: ChatImageInput
): Promise<VisualPreviewAssetRef | undefined> {
  try {
    const id = await conversationAssetStore.saveImage(ctx.conversationId, ctx.messageId, image)
    return { conversationId: ctx.conversationId, id }
  } catch (error) {
    // Live rendering still works from the data URL. Only restart recovery is unavailable.
    log.warn('Could not persist visual preview:', error)
    return undefined
  }
}
