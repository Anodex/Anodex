import type { ChatImageInput } from '@shared/chat.types'
import type { VisualPreviewAssetRef } from '@shared/tools.types'
import type { WorkspaceToolContext } from './types'
import { conversationAssetStore } from '../conversations/ConversationAssetStore'
import { createLogger } from '../utils/logger'

const log = createLogger('visual-preview-assets')

/** Persist preview pixels separately from conversation JSON when storage is available. */
export async function saveVisualPreviewAsset(
  ctx: WorkspaceToolContext,
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
