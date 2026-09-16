import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { broadcastToOtherClients } from '../broadcast'
import { isRemoteCall, resolveClientChannel } from '../clients/clientRegistry'
import type {
  Conversation,
  ConversationState,
  ConversationSummary
} from '@shared/conversation.types'
import { err, ok, toErrorMessage } from '@shared/result'
import { conversationStore } from '../conversations/ConversationStore'
import { forRemote } from '../conversations/remoteTranscript'
import { attachmentPreview } from '../conversations/attachmentPreview'
import { branchForEdit } from '../conversations/branchForEdit'
import { searchConversationBodies } from '../conversations/conversationBodySearch'
import { searchWords } from '@shared/transcriptSearch'
import { conversationAssetStore } from '../conversations/ConversationAssetStore'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:conversations')

/** IPC handlers for conversation persistence. */
export function registerConversationHandlers(): void {
  ipcMain.handle(IpcChannel.Conversations.list, () => conversationStore.list())

  // From the shallow list: a sidebar shows titles, and reading every old chat's
  // messages to throw them away again is the work this avoids.
  ipcMain.handle(IpcChannel.Conversations.listWithoutMessages, () =>
    conversationStore.listShallow().map(({ conversation }) => withoutMessages(conversation))
  )

  // Given ids, only those conversations; one archived or gone is simply absent. A
  // phone told one conversation changed reads that row rather than the whole list,
  // which on a real store is tens of kilobytes every save.
  ipcMain.handle(IpcChannel.Conversations.listSummaries, (_event, ids?: unknown) =>
    shallowSummariesOf(conversationStore.listShallow(), ids)
  )

  ipcMain.handle(
    IpcChannel.Conversations.thinking,
    (_event, conversationId: string, messageId: string) =>
      thinkingOf(conversationStore.get(conversationId), messageId)
  )

  // The desktop sidebar searches here too, now that the window no longer holds every
  // conversation's messages — from the first character, as it did in the window.
  //
  // Only the chats whose words could answer the query are opened: at a character a
  // keystroke, reading all of them was 120ms of the main process and put every chat
  // back in memory for two minutes.
  ipcMain.handle(IpcChannel.Conversations.search, (event, query: string) => {
    const text = typeof query === 'string' ? query : ''
    return searchConversationBodies(
      conversationStore.searchable(searchWords(text), { archived: false }),
      text,
      isRemoteCall(event) ? undefined : 1
    )
  })

  ipcMain.handle(IpcChannel.Conversations.get, (event, conversationId: string, limit?: number) => {
    const conversation = conversationStore.get(conversationId)
    if (!conversation) return null

    // The tail, because that is what a reader wants and what a model was last
    // talking about. Sending the head of a thousand-turn conversation is both
    // larger and less useful.
    const tail =
      limit == null || conversation.messages.length <= limit
        ? conversation
        : { ...conversation, messages: conversation.messages.slice(-limit) }

    // A count is not a size. Two hundred turns of an agent transcript carry tool
    // calls, render blocks and context assemblies the phone never reads, and one
    // reply asked to write a web page carries the page — which is how a 6MB frame
    // came to be refused outright by `MAX_RESPONSE_BYTES`, leaving conversations
    // that simply would not open from away. `forRemote` sends the four fields the
    // phone does read, and as many turns of them as will fit.
    return isRemoteCall(event) ? forRemote(tail) : tail
  })

  ipcMain.handle(
    IpcChannel.Conversations.branchForEdit,
    (event, conversationId: string, messageId: string) => {
      const outcome = branchForEdit(conversationStore.get(conversationId), messageId, Date.now())
      if (!outcome.ok) {
        return err(
          `conversations.edit-${outcome.reason}`,
          outcome.reason === 'project-chat'
            ? 'Replies after this message may have changed project files. Edit it on the computer, where those changes can be rolled back.'
            : 'That message cannot be edited.'
        )
      }
      try {
        // A plain save, not a remote merge: a merge keeps every stored turn, and
        // removing turns is the point.
        conversationStore.save(outcome.conversation)
        broadcastToOtherClients(
          resolveClientChannel(event),
          IpcChannel.Conversations.changed,
          conversationId
        )
        return ok({ remainingMessages: outcome.conversation.messages.length })
      } catch (error) {
        return err(
          'conversations.edit-failed',
          'Could not edit that message.',
          toErrorMessage(error)
        )
      }
    }
  )

  ipcMain.handle(
    IpcChannel.Conversations.attachmentPreview,
    (_event, conversationId: string, messageId: string, index: number) =>
      attachmentPreview(conversationId, messageId, index)
  )

  ipcMain.handle(IpcChannel.Conversations.listArchived, (event) => {
    // Without messages, for either client: the archive lists names and dates and
    // never opens what it lists, and an archived conversation's messages are left
    // on disk until something does.
    const archived = conversationStore.listArchivedWithoutMessages()

    // A phone gets summaries, not transcripts.
    //
    // `listArchived` returns whole conversations, every message included. A window
    // can hold that; a socket cannot — the bridge refuses anything over
    // `MAX_RESPONSE_BYTES` with `response-too-large`, so on any real store the
    // archive screen failed outright rather than rendering slowly. This is the same
    // failure `forRemote` was written for on the tail read, and the same narrowing:
    // the archive lists names and dates, and never opens what it lists.
    return isRemoteCall(event)
      ? archived.map(({ conversation, messageCount }) => ({
          ...toSummary(conversation),
          messageCount
        }))
      : archived.map(({ conversation }) => conversation)
  })

  ipcMain.handle(IpcChannel.Conversations.save, (event, conversation: Conversation) => {
    assertMessagesLoaded(conversation)
    try {
      // A remote client may only be holding the tail of this conversation, so its
      // turns are merged rather than written over what is on disk. See
      // `ConversationStore.save`.
      conversationStore.save(conversation, { fromRemote: isRemoteCall(event) })

      // Every save is announced, to every client except the one that wrote it.
      //
      // This used to fire only for remote saves, so that a renderer would not be
      // told about its own edit mid-keystroke. That solved the echo and created a
      // worse hole: a conversation the *computer* wrote was announced to nobody, so
      // a paired phone watching a chat the desktop was working on never heard that
      // it had changed. It sat on the last turn it happened to have loaded.
      //
      // Excluding the author gets both: no client is told what it already knows,
      // and every other client — window or phone — finds out.
      broadcastToOtherClients(
        resolveClientChannel(event),
        IpcChannel.Conversations.changed,
        conversation.id
      )
    } catch (error) {
      log.error('Failed to save conversation:', conversation.id, error)
      throw new Error('Could not save conversation.')
    }
  })

  ipcMain.handle(IpcChannel.Conversations.delete, (event, id: string) => {
    try {
      conversationStore.delete(id)
      announceChange(event, id)
    } catch (error) {
      log.error('Failed to delete conversation:', id, error)
      throw new Error('Could not delete conversation.')
    }
  })

  ipcMain.handle(IpcChannel.Conversations.restore, (event, id: string) => {
    try {
      conversationStore.restore(id)
      announceChange(event, id)
    } catch (error) {
      log.error('Failed to restore conversation:', id, error)
      throw new Error('Could not restore conversation.')
    }
  })

  ipcMain.handle(IpcChannel.Conversations.deletePermanent, (event, id: string) => {
    try {
      conversationStore.deletePermanent(id)
      announceChange(event, id)
    } catch (error) {
      log.error('Failed to permanently delete conversation:', id, error)
      throw new Error('Could not permanently delete conversation.')
    }
  })

  ipcMain.handle(IpcChannel.Conversations.deleteAll, () => {
    try {
      conversationStore.deleteAll()
    } catch (error) {
      log.error('Failed to delete all conversations:', error)
      throw new Error('Could not delete all conversations.')
    }
  })

  ipcMain.handle(IpcChannel.Conversations.deleteArchived, (_event, ids: string[]) => {
    try {
      conversationStore.deleteArchived(ids)
    } catch (error) {
      log.error('Failed to delete archived conversations:', error)
      throw new Error('Could not delete archived conversations.')
    }
  })

  ipcMain.handle(IpcChannel.Conversations.getState, () => conversationStore.getState())

  ipcMain.handle(IpcChannel.Conversations.setState, (_event, state: ConversationState) => {
    try {
      conversationStore.setState(state)
    } catch (error) {
      log.error('Failed to save conversation state:', error)
      throw new Error('Could not save conversation state.')
    }
  })

  ipcMain.handle(
    IpcChannel.Conversations.readVisualPreview,
    async (_event, conversationId: string, assetId: string) => {
      try {
        return ok(await conversationAssetStore.readImage(conversationId, assetId))
      } catch (error) {
        log.warn('Failed to read visual preview:', conversationId, assetId, error)
        return err(
          'conversations.visual-preview-unavailable',
          'This inspected screenshot is no longer available.',
          toErrorMessage(error)
        )
      }
    }
  )

  ipcMain.handle(IpcChannel.Conversations.getVisualPreviewUsage, async () => {
    try {
      return ok(await conversationAssetStore.getUsage())
    } catch (error) {
      log.warn('Failed to read visual preview usage:', error)
      return err(
        'conversations.visual-preview-usage-failed',
        'Could not read visual preview storage usage.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Conversations.clearVisualPreviews, async () => {
    try {
      return ok(await conversationAssetStore.clearAll())
    } catch (error) {
      log.warn('Failed to clear visual previews:', error)
      return err(
        'conversations.visual-preview-clear-failed',
        'Could not clear visual previews.',
        toErrorMessage(error)
      )
    }
  })
}

/**
 * Tell every other client that a conversation changed — archived, restored or removed.
 *
 * Saves were already announced; these were not. So a chat archived from the phone
 * stayed in the desktop's sidebar until Anodex restarted, and one archived at the desk
 * stayed in the phone's list. The author is left out for the same reason as on save:
 * it has already updated itself.
 */
function announceChange(event: unknown, conversationId: string): void {
  broadcastToOtherClients(
    resolveClientChannel(event),
    IpcChannel.Conversations.changed,
    conversationId
  )
}

/** A conversation as the window lists it: everything but its messages. */
export function withoutMessages(conversation: Conversation): Conversation {
  return { ...conversation, messages: [], messagesNotLoaded: true }
}

/**
 * Refuse to save a copy whose messages were never loaded.
 *
 * Saved, it would replace the conversation on disk with no messages at all. The
 * window reads a conversation's messages before changing one; this is the check
 * that holds if some path ever forgets to.
 */
export function assertMessagesLoaded(conversation: Conversation): void {
  if (conversation?.messagesNotLoaded) {
    log.error('Refused to save a conversation whose messages were not loaded:', conversation.id)
    throw new Error('Could not save chat: its messages were not loaded.')
  }
}

/** Every summary, or only those named when `ids` is a list of them. */
/**
 * The same summaries from the shallow list, where a chat's length is known without
 * its messages — see `ConversationStore.listShallow`.
 */
export function shallowSummariesOf(
  rows: Array<{ conversation: Conversation; messageCount: number }>,
  ids?: unknown
): ConversationSummary[] {
  const wanted = Array.isArray(ids)
    ? new Set(ids.filter((id): id is string => typeof id === 'string'))
    : null
  return rows
    .filter((row) => !wanted || wanted.has(row.conversation.id))
    .map(({ conversation, messageCount }) => ({ ...toSummary(conversation), messageCount }))
}

export function summariesOf(conversations: Conversation[], ids?: unknown): ConversationSummary[] {
  if (!Array.isArray(ids)) return conversations.map(toSummary)
  const wanted = new Set(ids.filter((id): id is string => typeof id === 'string'))
  return conversations.filter((conversation) => wanted.has(conversation.id)).map(toSummary)
}

/** One message's saved thinking, or null when it has none or is not there. */
export function thinkingOf(
  conversation: Conversation | null | undefined,
  messageId: string
): string | null {
  const message = conversation?.messages.find((candidate) => candidate.id === messageId)
  return message?.thinking?.trim() ? message.thinking : null
}

/**
 * A conversation minus its messages.
 *
 * `messageCount` rather than the messages themselves: a list shows how long a
 * conversation is, never what is in it, and the messages are the entire reason the
 * full store is too large to send anywhere.
 */
export function toSummary(conversation: Conversation): ConversationSummary {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    archived: conversation.archived,
    // So a caller can tell a chat somebody had from a run the machine did. The
    // phone's recents list is the reason: without this every scheduled run and
    // benchmark script sat in it looking exactly like a conversation.
    origin: conversation.origin
  }
}
