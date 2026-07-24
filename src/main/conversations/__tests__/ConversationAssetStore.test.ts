import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatImageInput } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'
import { ConversationAssetStore } from '../ConversationAssetStore'

const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from('persisted-preview-pixels')
])

const IMAGE: ChatImageInput = {
  path: 'page.html',
  name: 'page.screenshot.png',
  mimeType: 'image/png',
  sizeBytes: PNG.length,
  dataUrl: `data:image/png;base64,${PNG.toString('base64')}`
}

describe('ConversationAssetStore', () => {
  let root: string
  let store: ConversationAssetStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anodex-conversation-assets-'))
    store = new ConversationAssetStore()
    store.init(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('stores and reopens exact visual inspection pixels', async () => {
    const assetId = await store.saveImage('conversation-1', 'message-1', IMAGE)
    const reopened = await store.readImage('conversation-1', assetId)

    expect(assetId).toMatch(/^message-1-[a-f0-9-]+\.png$/)
    expect(reopened).toEqual({
      dataUrl: IMAGE.dataUrl,
      mimeType: 'image/png'
    })
  })

  it('prunes assets discarded by transcript editing and removes conversation assets', async () => {
    const keptAssetId = await store.saveImage('conversation-1', 'message-1', IMAGE)
    const discardedAssetId = await store.saveImage('conversation-1', 'message-2', IMAGE)
    const conversation: Conversation = {
      id: 'conversation-1',
      projectId: null,
      title: 'Visual test',
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Done.',
          createdAt: 1,
          toolCalls: [
            {
              id: 'tool-1',
              name: 'inspect_visual',
              kind: 'read',
              title: 'Inspect page.html',
              status: 'success',
              preview: {
                kind: 'image',
                title: 'Rendered page.html',
                path: 'page.html',
                mimeType: 'image/png',
                asset: {
                  conversationId: 'conversation-1',
                  id: keptAssetId
                }
              }
            }
          ]
        }
      ],
      createdAt: 1,
      updatedAt: 1
    }

    store.pruneConversation(conversation)

    await expect(store.readImage('conversation-1', keptAssetId)).resolves.toBeTruthy()
    await expect(store.readImage('conversation-1', discardedAssetId)).rejects.toThrow()

    store.removeConversation('conversation-1')
    await expect(store.readImage('conversation-1', keptAssetId)).rejects.toThrow()
  })

  it('rejects unsafe identifiers before resolving asset paths', async () => {
    await expect(store.saveImage('../outside', 'message-1', IMAGE)).rejects.toThrow(
      'Unsafe conversation id'
    )
    await expect(store.readImage('conversation-1', '../preview.png')).rejects.toThrow(
      'Unsafe visual preview asset id'
    )
  })
})
