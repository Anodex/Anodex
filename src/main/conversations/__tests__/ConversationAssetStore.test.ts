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

  it('reports usage and clears preview pixels without touching conversation data', async () => {
    const first = await store.saveImage('conversation-1', 'message-1', IMAGE)
    await store.saveImage('conversation-2', 'message-2', IMAGE)

    await expect(store.getUsage()).resolves.toMatchObject({
      totalBytes: PNG.length * 2,
      fileCount: 2,
      conversationCount: 2
    })
    await expect(store.clearAll()).resolves.toEqual({
      removedBytes: PNG.length * 2,
      removedFiles: 2
    })
    await expect(store.getUsage()).resolves.toMatchObject({
      totalBytes: 0,
      fileCount: 0,
      conversationCount: 0
    })
    await expect(store.readImage('conversation-1', first)).rejects.toThrow()
  })

  it('automatically removes oldest previews over per-conversation and total limits', async () => {
    const limited = new ConversationAssetStore({
      conversationBytes: PNG.length * 2,
      totalBytes: PNG.length * 2
    })
    limited.init(root)

    await limited.saveImage('conversation-1', 'message-1', IMAGE)
    await limited.saveImage('conversation-1', 'message-2', IMAGE)
    const newest = await limited.saveImage('conversation-1', 'message-3', IMAGE)
    await expect(limited.getUsage()).resolves.toMatchObject({
      totalBytes: PNG.length * 2,
      fileCount: 2,
      conversationCount: 1
    })
    await expect(limited.readImage('conversation-1', newest)).resolves.toBeTruthy()

    const other = await limited.saveImage('conversation-2', 'message-4', IMAGE)
    await expect(limited.getUsage()).resolves.toMatchObject({
      totalBytes: PNG.length * 2,
      fileCount: 2
    })
    await expect(limited.readImage('conversation-2', other)).resolves.toBeTruthy()
  })
})

describe('ConversationAssetStore — what prune counts as still referenced', () => {
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

  /** A conversation whose only reference to `assetId` is through `blocks`. */
  function conversationWithBlockPreview(assetId: string): Conversation {
    return {
      id: 'conversation-1',
      projectId: null,
      title: 'Visual test',
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Done.',
          createdAt: 1,
          blocks: [
            {
              type: 'tool',
              call: {
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
                  asset: { conversationId: 'conversation-1', id: assetId }
                }
              }
            }
          ]
        }
      ],
      createdAt: 1,
      updatedAt: 1
    }
  }

  it('keeps an asset referenced only through a message block', async () => {
    // `blocks` is where the renderer keeps interleaved tool calls, so this is
    // the ordinary shape for anything recent. Prune runs on every conversation
    // read, and anything it fails to recognise as referenced is deleted.
    const assetId = await store.saveImage('conversation-1', 'message-1', IMAGE)

    store.pruneConversation(conversationWithBlockPreview(assetId))

    await expect(store.readImage('conversation-1', assetId)).resolves.toBeTruthy()
  })

  it('ignores a preview that claims to belong to a different conversation', async () => {
    // The asset id alone is not authority to keep a file in this directory.
    const assetId = await store.saveImage('conversation-1', 'message-1', IMAGE)
    const conversation = conversationWithBlockPreview(assetId)
    const block = conversation.messages[0].blocks?.[0]
    if (
      block?.type === 'tool' &&
      block.call.preview?.kind === 'image' &&
      block.call.preview.asset
    ) {
      block.call.preview.asset.conversationId = 'somewhere-else'
    }

    store.pruneConversation(conversation)

    await expect(store.readImage('conversation-1', assetId)).rejects.toThrow()
  })

  it('takes the now-empty conversation directory with it', async () => {
    const assetId = await store.saveImage('conversation-1', 'message-1', IMAGE)
    expect((await store.getUsage()).conversationCount).toBe(1)

    store.pruneConversation({
      ...conversationWithBlockPreview(assetId),
      messages: []
    })

    expect((await store.getUsage()).fileCount).toBe(0)
    expect((await store.getUsage()).conversationCount).toBe(0)
  })
})

describe('ConversationAssetStore — path confinement at the choke point', () => {
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

  it('refuses a traversal id on every method that resolves a directory', async () => {
    // Validation lives in `dirForConversation` now, so it holds for whichever
    // method reaches it rather than depending on each one asking first.
    await expect(store.saveImage('../outside', 'message-1', IMAGE)).rejects.toThrow(
      'Unsafe conversation id'
    )
    await expect(store.readImage('../outside', 'preview.png')).rejects.toThrow()
    expect(() => store.removeConversation('../outside')).toThrow('Unsafe conversation id')
    expect(() =>
      store.pruneConversation({
        id: '../outside',
        projectId: null,
        title: 'x',
        messages: [],
        createdAt: 1,
        updatedAt: 1
      })
    ).toThrow('Unsafe conversation id')
  })

  it('refuses an absolute id, and an empty one', async () => {
    await expect(store.saveImage('/etc', 'message-1', IMAGE)).rejects.toThrow(
      'Unsafe conversation id'
    )
    await expect(store.saveImage('', 'message-1', IMAGE)).rejects.toThrow('Unsafe conversation id')
  })
})
