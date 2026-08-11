import { create } from 'zustand'
import { activeMaxResponseTokens } from '@shared/maxResponseTokens'
import { immer } from 'zustand/middleware/immer'
import type { ChatAttachment, HistoryCompactionEvent } from '@shared/chat.types'
import type {
  CheckpointPreview,
  CheckpointSummary,
  RestoreCheckpointResult
} from '@shared/checkpoint.types'
import type { Conversation, EmailThreadLink } from '@shared/conversation.types'
import {
  contextLedgerCauseFromSnapshotReason,
  mergeConversationContext,
  withLedgerRevision
} from '@shared/context.types'
import { TOOL_CATALOG, type ToolActivityEvent, type ToolCall } from '@shared/tools.types'
import { err } from '@shared/result'
import { stripToolCallText } from '@shared/toolCallText'
import {
  messageToHistoryTurn,
  sanitizeAssistantContent,
  sanitizeConversationTranscript
} from '@shared/chatSanitizer'
import { anodex } from '../lib/anodex'
import { createId } from '../lib/id'
import { notifyError, useUiStore } from './uiStore'
import { useSettingsStore } from './settingsStore'
import { useModelStore } from './modelStore'
import { playChime } from '../lib/sound'
import { notifyDesktop, shouldShowDesktopToast } from '../lib/notifications'
import {
  buildPromptWithAttachments,
  isAbsoluteAttachmentPath,
  type ComposerAttachment
} from '../lib/attachments'
import { reconcileMessageBlocks } from '../features/chat/reconcileMessageBlocks'
import { quarantineStreamingToolPayload } from '../features/chat/streamingToolPayload'
import { isChatReady } from '../lib/chatReadiness'
import { buildMessageEditBranch, buildRegenerateTarget } from '../features/chat/messageEdit'
import { describeGenerationStop } from '../features/chat/generationStopMessages'
import { withEmailThreadContext } from '../features/chat/emailThreadContext'
import { conversationUserFiles } from '../features/chat/conversationUserFiles'

export type { Conversation }

/** A message queued from the composer while a turn is still streaming. */
export interface PendingMessage {
  id: string
  text: string
  attachments: ComposerAttachment[]
}

export interface MessageEditOptions {
  forceRollback?: boolean
  keepPaths?: string[]
}

export type MessageEditResult =
  { status: 'completed' } | { status: 'conflict'; conflicts: string[] } | { status: 'failed' }

interface ChatState {
  conversations: Conversation[]
  activeId: string | null
  loaded: boolean
  /** Messages queued (per conversation) while that conversation is still generating. */
  pendingMessages: Record<string, PendingMessage[]>
  /** Load persisted conversations and active state from the main process. */
  load: () => Promise<void>
  /**
   * Create a new chat. Defaults to a general chat outside any project;
   * callers pass a project id to scope it to that project explicitly. This
   * never falls back to "whatever project happens to be active" — a chat
   * created without an explicit project must not silently inherit one.
   */
  newConversation: (projectId?: string | null, emailThread?: EmailThreadLink) => string
  /**
   * Selects the chat already tied to an email thread, or starts one and links
   * it. Keeps all discussion of a given email in one chat instead of spawning
   * a new one on every Reply or Summarize click.
   */
  openEmailThreadConversation: (
    accountId: string,
    threadId: string,
    details?: Pick<EmailThreadLink, 'subject' | 'latestMessageId'>
  ) => string
  /**
   * Drops a thread-linked chat that was opened but never used.
   *
   * The Email page links a chat the moment a thread is opened, so the rail's
   * composer has somewhere to send. Without this, reading twenty emails would
   * leave twenty empty "New chat" entries in the sidebar — the chat is only
   * worth keeping once there is something in it.
   */
  discardUnusedEmailThreadConversation: (id: string) => void
  /**
   * Text to drop into the composer the next time it renders, then clear.
   *
   * Lets another view hand work off to chat with the instruction already
   * written — the Email page's Reply button, for one — while still leaving the
   * user free to edit or discard it before sending. Sending outright would take
   * that choice away.
   */
  pendingComposerText: string | null
  setPendingComposerText: (text: string | null) => void
  /**
   * Copies a conversation's history into a new, ordinary chat and selects it.
   * Used to carry a scheduled task's run log into a chat the user can actually
   * reply in, without turning the log itself into a conversation. Returns the
   * new id, or null if the source is gone.
   */
  forkConversation: (sourceId: string, title: string) => string | null
  selectConversation: (id: string) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  restoreConversation: (id: string) => Promise<void>
  deleteConversationPermanent: (id: string) => Promise<void>
  /** Archive every active conversation (all projects and general chats). */
  deleteAllConversations: () => Promise<void>
  refreshConversations: () => Promise<void>
  /**
   * Detach a conversation from a project that no longer exists — e.g. the
   * project was deleted while this conversation survived (an interrupted
   * delete, or data from an older build). Moves it back to being a general
   * chat instead of leaving it permanently unable to activate its project.
   */
  clearOrphanedProjectId: (id: string) => Promise<void>
  /**
   * `conversationIdOverride` targets a specific conversation instead of the
   * active one — used when auto-dispatching a queued message so it lands in
   * the conversation it was queued for, even if the user has since switched
   * to a different chat.
   */
  sendMessage: (
    text: string,
    attachments?: ComposerAttachment[],
    conversationIdOverride?: string
  ) => Promise<void>
  /** Replace a past user turn, roll back discarded file changes, and regenerate. */
  editMessage: (
    messageId: string,
    text: string,
    options?: MessageEditOptions
  ) => Promise<MessageEditResult>
  /**
   * Ask for a different answer to the same question — replays the user turn
   * that prompted `messageId` unchanged. The recovery that fits a reply which
   * stalled or claimed work it never did, where the prompt was never the
   * problem and editing it only obscures that.
   */
  regenerateMessage: (messageId: string, options?: MessageEditOptions) => Promise<MessageEditResult>
  /** Queue a message onto the active conversation while it's still generating. */
  queueMessage: (text: string, attachments?: ComposerAttachment[]) => void
  /** Cancel a queued message before it's auto-sent. */
  removeQueuedMessage: (conversationId: string, id: string) => void
  stopGeneration: () => Promise<void>
  /** Manually summarize older turns into the conversation's durable context snapshot. */
  compactConversation: () => Promise<void>
  /** Called by the IPC bridge for each streamed token. */
  appendToken: (conversationId: string, messageId: string, token: string) => void
  /** Called by the IPC bridge for each streamed chain-of-thought token. */
  appendThinkingToken: (conversationId: string, messageId: string, token: string) => void
  /** Called by the IPC bridge as the assistant's tool calls progress. */
  applyToolActivity: (event: ToolActivityEvent) => void
  /**
   * Same effect as calling `applyToolActivity` once per call, but as a
   * single store commit — see `useAnodexBridge.ts`'s `TokenBatcher` doc
   * comment for why: a burst of tool-activity events arriving within one
   * animation frame (a model calling many read-only tools back to back with
   * little text between them) previously triggered one full MessageBubble
   * re-render per event.
   */
  applyToolActivityBatch: (conversationId: string, messageId: string, calls: ToolCall[]) => void
  /** Persist a durable context snapshot after the main process compacts history. */
  applyHistoryCompaction: (event: HistoryCompactionEvent) => void
  /** Inspect file changes and conflicts for one assistant message checkpoint. */
  inspectCheckpoint: (
    conversationId: string,
    messageId: string,
    projectIdOverride?: string
  ) => Promise<CheckpointPreview | null>
  /** Restore selected file changes made by one assistant message checkpoint. */
  restoreCheckpoint: (
    conversationId: string,
    messageId: string,
    paths: string[],
    force?: boolean,
    projectIdOverride?: string
  ) => Promise<RestoreCheckpointResult | null>
  /** Keep a persisted message summary aligned with checkpoint actions from outside chat. */
  syncCheckpointSummary: (
    conversationId: string,
    messageId: string,
    checkpoint: CheckpointSummary
  ) => void
}

const DEFAULT_TITLE = 'New chat'
const pendingToolPayloadByMessage = new Map<string, string>()

/**
 * Lays a freshly-loaded conversation list over the current one, keeping any
 * conversation that has a turn still streaming.
 *
 * A turn in progress exists only in renderer state — `sendMessage` persists it
 * once, at completion — so replacing the array wholesale with what is on disk
 * discards both the user's message and the reply being streamed into it. And
 * nothing reports it: `appendToken` silently drops tokens for a message it can
 * no longer find, the finalize step returns early for the same reason, and the
 * conversation is then persisted in its truncated form.
 *
 * This is not a rare refresh. `useAnodexBridge` calls it on every scheduler and
 * agent-run broadcast, and an agent run broadcasts once per turn — so leaving a
 * run going in the background while chatting was enough to erase the chat.
 */
export function preserveInFlight(current: Conversation[], loaded: Conversation[]): Conversation[] {
  const inFlight = new Map(
    current.filter((c) => c.messages.some((m) => m.streaming)).map((c) => [c.id, c])
  )
  if (inFlight.size === 0) return loaded

  const merged = loaded.map((c) => {
    const live = inFlight.get(c.id)
    return live ? withPersistedTurnsMissingFrom(live, c) : c
  })
  // Still generating but absent from the loaded list — keep it until its turn
  // finishes rather than pulling the conversation out from under a live reply.
  for (const [id, conversation] of inFlight) {
    if (!merged.some((c) => c.id === id)) merged.unshift(conversation)
  }
  return merged
}

/**
 * Keep the live copy of a conversation, but carry over any turn that reached
 * disk while it was generating.
 *
 * Holding the live copy whole is what protects a streaming reply, and it is
 * also how a background turn got lost: a scheduled task or agent run writes
 * into its own conversation, and if the user happens to be mid-reply in that
 * same chat, the refresh skips it — so the live copy never learns about the
 * new turn, and persists over it when the reply finishes.
 *
 * Only messages the live copy has never seen are taken, appended in their
 * persisted order. Nothing is removed: a message missing from the persisted
 * copy is one this renderer has not saved yet, not one that was deleted.
 */
function withPersistedTurnsMissingFrom(live: Conversation, persisted: Conversation): Conversation {
  const known = new Set(live.messages.map((message) => message.id))
  const missing = persisted.messages.filter((message) => !known.has(message.id))
  if (missing.length === 0) return live
  // Appended rather than slotted in by time. The in-flight exchange is the
  // user's message and the reply streaming into it, and inserting between the
  // two to honour timestamps would split a question from its answer. Landing
  // the background turn after it reorders nothing that is already on screen,
  // and nothing is lost either way.
  return { ...live, messages: [...live.messages, ...missing] }
}

/**
 * The reducer for one tool-activity event, extracted so `applyToolActivity`
 * (one event) and `applyToolActivityBatch` (many events from one animation
 * frame) can share it — the batch variant applies several calls' worth of
 * this logic inside a single `set()`/Immer transaction instead of one per
 * event, which is the entire point of batching (see
 * `applyToolActivityBatch`'s doc comment).
 */
function applyOneToolActivity(
  state: ChatState,
  conversationId: string,
  messageId: string,
  call: ToolCall
): void {
  const convo = state.conversations.find((c) => c.id === conversationId)
  const message = convo?.messages.find((m) => m.id === messageId)
  if (!message || !convo) return
  if (!message.toolCalls) message.toolCalls = []
  const index = message.toolCalls.findIndex((c) => c.id === call.id)
  if (index >= 0) message.toolCalls[index] = call
  else message.toolCalls.push(call)

  // Mirror into the ordered timeline: a status update to an already-placed
  // call updates it in place; a new call id lands at the end, which is
  // exactly the right chronological spot since activity events arrive in
  // the order they occurred.
  if (!message.blocks) message.blocks = []
  const block = message.blocks.find((b) => b.type === 'tool' && b.call.id === call.id)
  if (block && block.type === 'tool') block.call = call
  else message.blocks.push({ type: 'tool', call })

  // A plan tool's activity event carries a full snapshot of the
  // conversation's plan — mirror it onto the conversation itself so the
  // Workspace Dock's Plan panel updates live, independent of which
  // message/tool card it came from.
  if (call.plan) convo.plan = call.plan
}

/**
 * Both helpers are called from many sites throughout this store, several as
 * `void persistX(...)` fire-and-forget — an IPC failure there would
 * otherwise become a silent unhandled promise rejection with no user-visible
 * signal at all. Catching and surfacing it here, once, covers every caller
 * instead of requiring each call site to remember to do it individually.
 */
async function persistConversation(conversation: Conversation): Promise<void> {
  try {
    await anodex.conversations.save(sanitizeConversationTranscript(conversation).conversation)
  } catch (error) {
    notifyError(
      'Could not save chat',
      error instanceof Error ? error.message : 'The save request failed.'
    )
  }
}

async function persistActiveState(activeId: string | null): Promise<void> {
  try {
    await anodex.conversations.setState({ activeConversationId: activeId })
  } catch (error) {
    notifyError(
      'Could not save chat state',
      error instanceof Error ? error.message : 'The request failed.'
    )
  }
}

/** Renderer mirror of persisted conversations, kept in sync with the main process. */
export const useChatStore = create<ChatState>()(
  immer((set, get) => ({
    conversations: [],
    activeId: null,
    loaded: false,
    pendingMessages: {},

    load: async () => {
      const conversations = await anodex.conversations.list()
      const state = await anodex.conversations.getState()
      set({
        conversations,
        activeId: state.activeConversationId,
        loaded: true
      })
      const active = conversations.find((c) => c.id === state.activeConversationId)
      if (active) useUiStore.getState().markConversationRead(active.id, active.updatedAt)
    },

    pendingComposerText: null,

    setPendingComposerText: (text) => set({ pendingComposerText: text }),

    openEmailThreadConversation: (accountId, threadId, details) => {
      // `conversations` holds only live chats — archiving or deleting removes
      // an entry — so a hit here is by definition a chat the user can still
      // return to, and a miss correctly starts fresh.
      const existing = get().conversations.find(
        (conversation) =>
          conversation.emailThread?.threadId === threadId &&
          conversation.emailThread.accountId === accountId
      )

      if (existing) {
        set((state) => {
          state.activeId = existing.id
          // The thread has probably moved on since this chat was last opened,
          // so refresh which message a reply should answer. Without this the
          // model keeps replying to whatever was newest the first time.
          const convo = state.conversations.find((c) => c.id === existing.id)
          if (convo?.emailThread && details) {
            Object.assign(convo.emailThread, details)
          }
        })
        useUiStore.getState().markConversationRead(existing.id, existing.updatedAt)
        void persistActiveState(existing.id)
        return existing.id
      }

      return get().newConversation(null, { accountId, threadId, ...details })
    },

    discardUnusedEmailThreadConversation: (id) => {
      const conversation = get().conversations.find((item) => item.id === id)
      // Only ever discards a chat this feature created and nobody used: linked
      // to a thread, no turns, and nothing typed. Anything else is the user's.
      if (!conversation?.emailThread || conversation.messages.length > 0) return
      // An instruction waiting in the composer is work in progress — the user
      // clicked Reply and then navigated away, and the chat has to survive for
      // them to come back to.
      if (get().pendingComposerText) return

      set((state) => {
        state.conversations = state.conversations.filter((item) => item.id !== id)
        if (state.activeId === id) state.activeId = null
      })
      if (get().activeId === null) void persistActiveState(null)
      void anodex.conversations.deletePermanent(id)
    },

    newConversation: (projectId = null, emailThread) => {
      const id = createId('c')
      const now = Date.now()
      const conversation: Conversation = {
        id,
        projectId,
        title: DEFAULT_TITLE,
        messages: [],
        createdAt: now,
        updatedAt: now,
        ...(emailThread ? { emailThread } : {})
      }
      set((state) => {
        state.conversations.unshift(conversation)
        state.activeId = id
      })
      useUiStore.getState().markConversationRead(id, now)
      void persistConversation(conversation)
      void persistActiveState(id)
      return id
    },

    forkConversation: (sourceId, title) => {
      const source = get().conversations.find((c) => c.id === sourceId)
      if (!source) return null
      const id = createId('c')
      const now = Date.now()
      const conversation: Conversation = {
        ...source,
        id,
        title,
        createdAt: now,
        updatedAt: now,
        // A fork is a chat the user is holding, so it drops the automated
        // origin — that flag is what keeps scheduled run logs out of the
        // sidebar's chat list, and this copy belongs there.
        origin: undefined,
        archived: false,
        archivedAt: undefined
      }
      set((state) => {
        state.conversations.unshift(conversation)
        state.activeId = id
      })
      useUiStore.getState().markConversationRead(id, now)
      void persistConversation(conversation)
      void persistActiveState(id)
      return id
    },

    selectConversation: async (id) => {
      const conversation = get().conversations.find((c) => c.id === id)
      set({ activeId: id })
      if (conversation) useUiStore.getState().markConversationRead(id, conversation.updatedAt)
      await persistActiveState(id)
    },

    renameConversation: async (id, title) => {
      const nextTitle = title.trim()
      if (!nextTitle) return
      set((state) => {
        const conversation = state.conversations.find((c) => c.id === id)
        if (!conversation) return
        conversation.title = nextTitle
        conversation.updatedAt = Date.now()
      })
      const nextConversation = get().conversations.find((c) => c.id === id)
      if (nextConversation) {
        useUiStore.getState().markConversationRead(id, nextConversation.updatedAt)
      }
      if (nextConversation) await persistConversation(nextConversation)
    },

    deleteConversation: async (id) => {
      // Await the IPC call before touching state (same reasoning as
      // deleteAllConversations below) — a failed delete leaves the chat
      // list intact, with an error surfaced, instead of the sidebar
      // dropping an item that's still actually on disk.
      try {
        await anodex.conversations.delete(id)
      } catch (error) {
        notifyError(
          'Could not delete chat',
          error instanceof Error ? error.message : 'The delete request failed.'
        )
        return
      }
      set((state) => {
        state.conversations = state.conversations.filter((c) => c.id !== id)
        if (state.activeId === id) state.activeId = state.conversations[0]?.id ?? null
      })
      await persistActiveState(get().activeId)
    },

    restoreConversation: async (id) => {
      try {
        await anodex.conversations.restore(id)
        const conversations = await anodex.conversations.list()
        set((state) => {
          state.conversations = preserveInFlight(state.conversations, conversations)
        })
      } catch (error) {
        notifyError(
          'Could not restore chat',
          error instanceof Error ? error.message : 'The restore request failed.'
        )
      }
    },

    deleteConversationPermanent: async (id) => {
      try {
        await anodex.conversations.deletePermanent(id)
        const conversations = await anodex.conversations.list()
        set((state) => {
          state.conversations = preserveInFlight(state.conversations, conversations)
        })
      } catch (error) {
        notifyError(
          'Could not permanently delete chat',
          error instanceof Error ? error.message : 'The delete request failed.'
        )
      }
    },

    deleteAllConversations: async () => {
      // Await the IPC call before touching state — unlike an optimistic
      // clear, this means a failed delete leaves the chat list intact
      // (with an error surfaced) instead of showing an empty list that
      // doesn't match what's actually still on disk.
      try {
        await anodex.conversations.deleteAll()
      } catch (error) {
        notifyError(
          'Could not delete all chats',
          error instanceof Error ? error.message : 'The delete request failed.'
        )
        return
      }
      set({ conversations: [], activeId: null })
    },

    refreshConversations: async () => {
      try {
        const conversations = await anodex.conversations.list()
        set((state) => {
          state.conversations = preserveInFlight(state.conversations, conversations)
        })
      } catch (error) {
        notifyError(
          'Could not refresh chats',
          error instanceof Error ? error.message : 'The request failed.'
        )
      }
    },

    clearOrphanedProjectId: async (id) => {
      set((state) => {
        const conversation = state.conversations.find((c) => c.id === id)
        if (!conversation) return
        conversation.projectId = null
        conversation.updatedAt = Date.now()
      })
      const healed = get().conversations.find((c) => c.id === id)
      if (healed) await persistConversation(healed)
    },

    sendMessage: async (text, attachments = [], conversationIdOverride) => {
      const trimmed = text.trim()
      if (!trimmed && attachments.length === 0) return

      if (!ensureChatReady()) return

      const conversationId = conversationIdOverride ?? get().activeId ?? get().newConversation()
      if (!conversationId) return
      const existing = get().conversations.find((c) => c.id === conversationId)
      const projectId = existing?.projectId ?? null
      const history = (existing?.messages ?? []).map(messageToHistoryTurn)

      const titleSource = trimmed || attachments[0]?.name || DEFAULT_TITLE
      const fallbackTitle = deriveTitle(titleSource)
      const shouldGenerateTitle =
        existing?.title === DEFAULT_TITLE && existing.messages.length === 0
      const assistantId = createId('m')
      set((state) => {
        const convo = state.conversations.find((c) => c.id === conversationId)
        if (!convo) return
        const now = Date.now()
        convo.messages.push({
          id: createId('m'),
          role: 'user',
          content: trimmed,
          createdAt: now,
          attachments: attachments.length
            ? attachments.map((a) => ({
                path: a.path,
                name: a.name,
                sizeBytes: a.sizeBytes,
                kind: a.kind,
                mimeType: a.kind === 'image' ? a.mimeType : undefined
              }))
            : undefined
        })
        convo.messages.push({
          id: assistantId,
          role: 'assistant',
          content: '',
          createdAt: now,
          streaming: true
        })
        if (convo.title === DEFAULT_TITLE) convo.title = fallbackTitle
        convo.updatedAt = now
      })

      const settings = useSettingsStore.getState().settings
      const request = {
        conversationId,
        messageId: assistantId,
        projectId,
        systemPrompt: settings?.assistantStyle.globalStyle,
        context: existing?.context ?? null,
        history,
        prompt: withEmailThreadContext(
          buildPromptWithAttachments(trimmed, attachments),
          existing?.emailThread
        ),
        // Read from `existing` — the pre-send snapshot — plus this turn's own
        // attachments, which are not in it yet.
        userFiles: conversationUserFiles(existing?.messages ?? [], attachments),
        images: attachments
          .filter((attachment) => attachment.kind === 'image')
          .map((attachment) => ({
            path: attachment.path,
            name: attachment.name,
            mimeType: attachment.mimeType,
            dataUrl: attachment.dataUrl,
            sizeBytes: attachment.sizeBytes
          })),
        plan: existing?.plan ?? null,
        options: settings
          ? {
              temperature: settings.generation.temperature,
              topP: settings.generation.topP,
              // Only the provider actually handling this turn gets a say.
              // `undefined` means "no ceiling from the user", which each
              // provider resolves its own way — see `activeMaxResponseTokens`.
              maxTokens: activeMaxResponseTokens(settings)
            }
          : undefined
      }

      let result: Awaited<ReturnType<typeof anodex.chat.send>>
      try {
        result = await anodex.chat.send(request)
      } catch (error) {
        // An IPC-level rejection — the channel is gone, the main process died,
        // a field failed to serialize — never becomes the handler's own error
        // result. Left unhandled it skipped everything below: the bubble stayed
        // `streaming: true` for the rest of the session, its quarantined tail
        // leaked, and the conversation's queued messages never drained.
        result = err(
          'chat.send-failed',
          error instanceof Error ? error.message : 'The chat request failed.'
        )
      }

      // A stop that `describeGenerationStop` classifies as a genuine failure
      // rather than a bounded budget. Those arrive as `ok` with `stopped: true`,
      // which used to fall between both notification branches below: the bubble
      // turned red and nothing chimed, so a user who had stepped away from a
      // long run got no signal at all. Captured here because the note is built
      // inside the state update.
      let failureNote: string | null = null
      set((state) => {
        const convo = state.conversations.find((c) => c.id === conversationId)
        const message = convo?.messages.find((m) => m.id === assistantId)
        if (!convo || !message) return
        // Captured before it's cleared: a failed turn salvages this in the
        // error branch below (the ok branch recovers the same text from the
        // authoritative server reply instead).
        const quarantinedTail = pendingToolPayloadByMessage.get(assistantId) ?? ''
        pendingToolPayloadByMessage.delete(assistantId)
        message.streaming = false
        // The placeholder was stamped with the user message's time so the two
        // sorted together while empty; restamp it now it exists, or a turn that
        // took ten minutes of tool calls reads as having arrived instantly. The
        // unattended paths (AgentRunService, SchedulerService) already stamp
        // their assistant messages at completion — this matches them.
        message.createdAt = Date.now()
        if (result.ok) {
          const content = sanitizeAssistantContent(result.value.content)
          message.content = content
          message.stats = result.value.stats
          message.contextBudget = result.value.contextBudget
          message.blocks = reconcileMessageBlocks(
            message.blocks,
            content,
            message.toolCalls,
            [],
            trimmed,
            Boolean(projectId)
          )
          // `stopped: true` isn't always a user-initiated Stop (that path is
          // deliberately silent — no error, no chime, see below) — most other
          // reasons mean some internal budget or guard ended the turn early
          // on its own. Without this, that outcome renders as an empty or
          // truncated bubble with zero explanation (observed live: a project
          // chat's first message at a 4,096-token context produced a
          // completely blank reply and no error anywhere).
          if (result.value.stopReason) {
            const note = describeGenerationStop(
              result.value.stopReason,
              result.value.contextBudget,
              Boolean(content.trim()),
              result.value.stopDetail
            )
            if (note) {
              message.error = note.error
              if (note.errorKind) message.errorKind = note.errorKind
              else failureNote = note.error
            }
          }
          if (result.value.memoryUsed?.length) message.memoryUsed = result.value.memoryUsed
          if (result.value.transcriptRecallUsed?.length) {
            message.transcriptRecallUsed = result.value.transcriptRecallUsed
          }
          if (result.value.webSources?.length) message.webSources = result.value.webSources
          // Kept even when no sources came back — with an empty list that is
          // precisely the signal the reader needs, so it must not be dropped
          // as "falsy, therefore uninteresting".
          if (result.value.webSearchAttempted) {
            message.webSearchAttempted = true
          }
          if (result.value.checkpoint?.changedFiles.length) {
            message.checkpoint = result.value.checkpoint
          }
          if (result.value.thinking) message.thinking = result.value.thinking
          if (result.value.context) {
            convo.context = mergeConversationContext(convo.context, result.value.context)
          }
        } else {
          // A failed turn has no authoritative final reply to fall back on
          // (unlike the ok branch's `result.value.content`), so any text still
          // held in the tool-payload quarantine — tokens that *looked* like they
          // might begin a tool call, but which no tool call ever arrived to
          // consume, so they are real prose here — would otherwise be silently
          // dropped. Fold it back into the partial reply the user already
          // watched stream, so a mid-turn crash keeps its visible work.
          if (quarantinedTail) {
            message.content += quarantinedTail
            if (!message.blocks) message.blocks = []
            const lastBlock = message.blocks[message.blocks.length - 1]
            if (lastBlock?.type === 'text') lastBlock.text += quarantinedTail
            else message.blocks.push({ type: 'text', text: quarantinedTail })
          }
          if (message.toolCalls?.length) {
            const toolNames = TOOL_CATALOG.map((tool) => tool.name)
            message.content = stripToolCallText(message.content, new Set(toolNames))
            message.blocks = reconcileMessageBlocks(
              message.blocks,
              message.content,
              message.toolCalls,
              toolNames,
              trimmed,
              Boolean(projectId)
            )
          }
          message.error = result.error.message
        }
        convo.updatedAt = Date.now()
      })

      const finalConvo = get().conversations.find((c) => c.id === conversationId)
      if (finalConvo && get().activeId === conversationId) {
        useUiStore.getState().markConversationRead(conversationId, finalConvo.updatedAt)
      }
      if (finalConvo) void persistConversation(finalConvo)

      if (!result.ok) {
        // Also triggers the error chime via `uiStore.notify()`.
        notifyError('Generation failed', result.error.message)
      } else if (failureNote) {
        // The turn came back with its work intact but ended on a real fault
        // (the provider failed, the runtime stalled, a call was never
        // runnable). Worth the same chime as a thrown failure — it is one.
        notifyError('Generation failed', failureNote)
      } else if (!result.value.stopped) {
        // A user-initiated stop isn't a completion or an error — no chime/notification for it.
        playChime('success')
        if (shouldShowDesktopToast()) {
          const conversationTitle = finalConvo?.title ?? 'chat'
          // Only spend the extra local generation asking for a summary once we
          // already know a toast will actually be shown for it.
          const summary = await anodex.chat.summarize(result.value.content, 8).catch(() => null)
          notifyDesktop(summary ?? 'Reply ready', `In "${conversationTitle}"`)
        }
      }

      if (result.ok && !result.value.stopped && finalConvo && shouldGenerateTitle) {
        void generateConversationTitle({
          conversationId,
          expectedTitle: fallbackTitle,
          userPrompt: trimmed,
          assistantReply: result.value.content,
          attachmentNames: attachments.map((attachment) => attachment.name),
          editedFiles: editedFilesForAssistantMessage(finalConvo, assistantId)
        })
      }

      // Drain the next queued comment, if any, into a fresh turn on this same
      // conversation — regardless of whether it's still the active tab, and
      // regardless of ok/error/stopped, since a manual Stop only ends the
      // current reply; a queued message the user explicitly typed should
      // still go out unless they removed it themselves.
      const queued = get().pendingMessages[conversationId]
      if (queued && queued.length > 0) {
        const [next, ...rest] = queued
        set((state) => {
          state.pendingMessages[conversationId] = rest
        })
        void get().sendMessage(next.text, next.attachments, conversationId)
      }
    },

    editMessage: async (messageId, text, options = {}) => {
      const conversationId = get().activeId
      const conversation = get().conversations.find((item) => item.id === conversationId)
      const branch = conversation ? buildMessageEditBranch(conversation, messageId) : null
      const trimmed = text.trim()
      if (!conversation || !branch || (!trimmed && !branch.target.attachments?.length)) {
        return { status: 'failed' }
      }
      if (conversation.messages.some((message) => message.streaming)) {
        useUiStore.getState().notify({
          kind: 'info',
          title: 'Reply still in progress',
          message: 'Stop the current reply before editing an earlier message.'
        })
        return { status: 'failed' }
      }
      if (!ensureChatReady()) return { status: 'failed' }

      let attachments = await rehydrateAttachments(branch.target.attachments ?? [])
      if (!attachments) return { status: 'failed' }
      let workspaceRolledBack = false

      if (conversation.projectId && branch.discardedAssistantMessageIds.length > 0) {
        const rollback = await anodex.checkpoints
          .rollback({
            projectId: conversation.projectId,
            conversationId: conversation.id,
            messageIds: branch.discardedAssistantMessageIds,
            excludePaths: options.keepPaths,
            force: options.forceRollback
          })
          .catch((error: unknown) => {
            notifyError(
              'Could not edit message',
              error instanceof Error ? error.message : 'The rollback request failed.'
            )
            return null
          })
        if (!rollback) return { status: 'failed' }
        if (!rollback.ok) {
          notifyError('Could not edit message', rollback.error.message)
          return { status: 'failed' }
        }
        if (rollback.value.conflicts.length > 0) {
          return { status: 'conflict', conflicts: rollback.value.conflicts }
        }
        if (rollback.value.rolledBackMessages.length > 0) {
          workspaceRolledBack = true
          window.dispatchEvent(new Event('anodex:checkpoints-changed'))
        }
      }

      if (workspaceRolledBack && branch.target.attachments?.length) {
        const refreshedAttachments = await rehydrateAttachments(branch.target.attachments)
        if (refreshedAttachments) attachments = refreshedAttachments
      }

      const updatedAt = Date.now()
      set((state) => {
        const current = state.conversations.find((item) => item.id === conversation.id)
        if (!current) return
        current.messages = branch.retainedMessages
        if (branch.clearContext) current.context = null
        current.updatedAt = updatedAt
        state.pendingMessages[conversation.id] = []
      })

      const updated = get().conversations.find((item) => item.id === conversation.id)
      if (!updated) return { status: 'failed' }
      await persistConversation(updated)
      await get().sendMessage(trimmed, attachments, conversation.id)
      return { status: 'completed' }
    },

    regenerateMessage: async (messageId, options) => {
      const conversation = get().conversations.find((item) => item.id === get().activeId)
      const target = conversation ? buildRegenerateTarget(conversation.messages, messageId) : null
      if (!conversation || !target) return { status: 'failed' }

      if (conversation.messages.some((message) => message.streaming)) {
        useUiStore.getState().notify({
          kind: 'info',
          title: 'Reply still in progress',
          message: 'Stop the current reply before regenerating an earlier one.'
        })
        return { status: 'failed' }
      }

      const source = conversation.messages.find(
        (message) => message.id === target.sourceUserMessageId
      )
      if (!source) return { status: 'failed' }

      // Deliberately the same path as an edit whose text happened not to
      // change: identical branch, identical checkpoint rollback, identical
      // conflict reporting. Regenerating is that operation, not a new one.
      return get().editMessage(source.id, source.content, options)
    },

    queueMessage: (text, attachments = []) => {
      const trimmed = text.trim()
      if (!trimmed && attachments.length === 0) return
      const conversationId = get().activeId
      if (!conversationId) return
      set((state) => {
        const queue = state.pendingMessages[conversationId] ?? []
        queue.push({ id: createId('pending'), text: trimmed, attachments })
        state.pendingMessages[conversationId] = queue
      })
    },

    removeQueuedMessage: (conversationId, id) => {
      set((state) => {
        const queue = state.pendingMessages[conversationId]
        if (!queue) return
        state.pendingMessages[conversationId] = queue.filter((item) => item.id !== id)
      })
    },

    stopGeneration: async () => {
      const activeId = get().activeId
      if (activeId) await anodex.chat.stop(activeId)
    },

    compactConversation: async () => {
      const activeId = get().activeId
      const conversation = get().conversations.find((c) => c.id === activeId)
      if (!conversation) return
      if (useModelStore.getState().engine.status !== 'ready') {
        notifyError('No model loaded', 'Load a model before compacting chat context.')
        return
      }

      const result = await anodex.chat.compact({
        conversationId: conversation.id,
        context: conversation.context ?? null,
        history: conversation.messages.map(messageToHistoryTurn)
      })

      if (!result.ok) {
        notifyError('Could not compact chat', result.error.message)
        return
      }
      if (!result.value) {
        useUiStore.getState().notify({
          kind: 'info',
          title: 'Nothing to compact',
          message: 'This chat does not have enough older context to summarize yet.'
        })
        return
      }
      const compacted = result.value

      set((state) => {
        const convo = state.conversations.find((c) => c.id === compacted.conversationId)
        if (!convo) return
        convo.context = withLedgerRevision(convo.context, {
          id: createId('ctx'),
          createdAt: compacted.snapshot.createdAt,
          cause: 'manual',
          throughMessageId: compacted.snapshot.throughMessageId,
          coveredTurns: compacted.snapshot.removedTurns,
          continuityDigest: compacted.snapshot.summary
        })
        convo.updatedAt = Date.now()
      })
      const updated = get().conversations.find((c) => c.id === compacted.conversationId)
      if (updated) void persistConversation(updated)

      useUiStore.getState().notify({
        kind: 'success',
        title: 'Chat context compacted',
        message: `Summarized ${compacted.compactedTurns} older turn${
          compacted.compactedTurns === 1 ? '' : 's'
        } into the active context snapshot.`
      })
    },

    appendToken: (conversationId, messageId, token) => {
      set((state) => {
        const convo = state.conversations.find((c) => c.id === conversationId)
        const message = convo?.messages.find((m) => m.id === messageId)
        // Tokens are rAF-batched in `useAnodexBridge`, while `sendMessage`'s
        // finalize resolves on the un-throttled IPC promise — so a final
        // frame's worth of buffered tokens can flush AFTER the finalize that
        // already replaced `message.content` with the complete reply.
        // Appending them again would duplicate the reply's tail; once a
        // message stops streaming, late token flushes for it are dropped.
        // Implies `convo` too — the message was found by walking it.
        if (message?.streaming !== true) return

        const visibleToken = quarantineStreamingToolPayload(
          message,
          token,
          pendingToolPayloadByMessage
        )
        if (!visibleToken) return
        message.content += visibleToken
        // Tokens and tool-activity events both arrive over IPC in the exact
        // order they happened during generation, so appending each to a
        // shared timeline (instead of the separate content/toolCalls
        // fields) reconstructs the true interleaving — extend the current
        // trailing text block, or start a new one if the last block was a
        // tool call.
        if (!message.blocks) message.blocks = []
        const last = message.blocks[message.blocks.length - 1]
        if (last && last.type === 'text') last.text += visibleToken
        else message.blocks.push({ type: 'text', text: visibleToken })
      })
      // convo.updatedAt is intentionally left untouched here — it's already
      // bumped once at turn start (see `sendMessage`), which is all the
      // sidebar's recency sort needs. Re-touching it on every single token
      // would change the top-level `conversations` array reference (Immer
      // bubbles a new reference up through every ancestor of a mutated path)
      // hundreds of times per second, defeating the Sidebar's relevance-based
      // equality check below and re-running its full project/chat grouping
      // and sort on every token — this was directly observed to starve
      // window-resize repaints and the ChatRow hover-card's dismiss timer
      // during long generations, making the UI look frozen even though state
      // was updating correctly underneath.
      // Persisted when the generation completes in `sendMessage` to avoid
      // excessive disk writes on every streamed token.
    },

    // Mirrors `appendToken`'s timeline handling (extend the trailing block if
    // it's the same type, else start a new one) so a turn that thinks, calls
    // a tool, thinks again, then answers renders as a real chronological
    // timeline instead of every thought clustering at the top. `message.
    // thinking` is also kept updated as a flat convenience field — headless
    // callers (AgentRunService, SchedulerService) build a ChatMessage
    // directly without ever going through this live per-token path, so they
    // only ever have the flat field, never a positioned `blocks` entry.
    appendThinkingToken: (conversationId, messageId, token) => {
      set((state) => {
        const convo = state.conversations.find((c) => c.id === conversationId)
        const message = convo?.messages.find((m) => m.id === messageId)
        // Same late-flush guard as `appendToken` above — finalize already set
        // the complete `thinking` text, so a buffered flush after it would
        // append a duplicate tail.
        if (message?.streaming !== true) return
        message.thinking = (message.thinking ?? '') + token
        if (!message.blocks) message.blocks = []
        const last = message.blocks[message.blocks.length - 1]
        if (last && last.type === 'thinking') last.text += token
        else message.blocks.push({ type: 'thinking', text: token })
      })
    },

    applyToolActivity: ({ conversationId, messageId, call }) => {
      pendingToolPayloadByMessage.delete(messageId)
      set((state) => {
        applyOneToolActivity(state, conversationId, messageId, call)
      })
      // convo.updatedAt is deliberately not touched here — see the comment in
      // `appendToken` above; a turn with many tool calls is just as hot a
      // path as one with many tokens.
      // Persisted when the generation completes in `sendMessage`.
    },

    applyToolActivityBatch: (conversationId, messageId, calls) => {
      pendingToolPayloadByMessage.delete(messageId)
      set((state) => {
        for (const call of calls) applyOneToolActivity(state, conversationId, messageId, call)
      })
    },

    applyHistoryCompaction: (event) => {
      if (!event.summarized || !event.summary || !event.compactedThroughMessageId) {
        // Turns were omitted but not summarized (e.g. a cloud provider with
        // no summarizer wired up yet) — nothing to seed a snapshot from, but
        // the user should still know older context silently stopped being
        // sent, same reasoning as the summarized-toast below.
        if (event.reason === 'proactive' || event.reason === 'reactive') {
          useUiStore.getState().notify({
            kind: 'info',
            title: 'Older context omitted',
            message: `This conversation reached the model's context limit — ${
              event.removedTurns
            } older turn${event.removedTurns === 1 ? ' was' : 's were'} left out of this reply (no summary available yet).`
          })
        }
        return
      }
      const summary = event.summary
      const throughMessageId = event.compactedThroughMessageId

      set((state) => {
        const convo = state.conversations.find((c) => c.id === event.conversationId)
        if (!convo) return
        convo.context = withLedgerRevision(convo.context, {
          id: createId('ctx'),
          createdAt: event.createdAt,
          cause: contextLedgerCauseFromSnapshotReason(event.reason),
          throughMessageId,
          coveredTurns: event.coveredTurns ?? event.removedTurns,
          continuityDigest: summary
        })
        convo.updatedAt = Date.now()
      })

      const conversation = get().conversations.find((c) => c.id === event.conversationId)
      if (conversation) void persistConversation(conversation)

      // Unlike the manual "Compact" button (which already toasts, since the
      // user just took an explicit action), proactive/reactive compaction
      // was previously completely silent — the model's context window would
      // shrink out from under a long conversation with no visible signal at
      // all, making it confusing when the model seemed to "forget"
      // something from many turns back. `onLoad` (rebuilding an
      // already-compacted session on conversation switch) isn't new
      // information and would just be noise, so it's excluded.
      if (event.removedTurns > 0 && (event.reason === 'proactive' || event.reason === 'reactive')) {
        useUiStore.getState().notify({
          kind: 'info',
          title: 'Chat context compacted',
          message: `This conversation reached the model's context limit — summarized ${
            event.removedTurns
          } older turn${event.removedTurns === 1 ? '' : 's'} to keep going.`
        })
      }
    },

    inspectCheckpoint: async (conversationId, messageId, projectIdOverride) => {
      const conversation = get().conversations.find((item) => item.id === conversationId)
      const projectId = projectIdOverride ?? conversation?.projectId
      if (!projectId) return null

      const result = await anodex.checkpoints.inspect({
        projectId,
        conversationId,
        messageId
      })
      if (!result.ok) {
        notifyError('Could not inspect checkpoint', result.error.message)
        return null
      }
      return result.value
    },

    restoreCheckpoint: async (
      conversationId,
      messageId,
      paths,
      force = false,
      projectIdOverride
    ) => {
      const conversation = get().conversations.find((item) => item.id === conversationId)
      const projectId = projectIdOverride ?? conversation?.projectId
      if (!projectId) return null

      const result = await anodex.checkpoints.restore({
        projectId,
        conversationId,
        messageId,
        paths,
        force
      })
      if (!result.ok) {
        notifyError('Could not restore checkpoint', result.error.message)
        return null
      }

      if (result.value.restoredFiles.length > 0) {
        const updatedAt = Date.now()
        set((state) => {
          const convo = state.conversations.find((item) => item.id === conversationId)
          const assistant = convo?.messages.find((item) => item.id === messageId)
          if (!convo || !assistant?.checkpoint) return
          assistant.checkpoint = result.value.checkpoint
          convo.updatedAt = updatedAt
        })

        const updated = get().conversations.find((item) => item.id === conversationId)
        if (updated) void persistConversation(updated)
        useUiStore.getState().notify({
          kind: 'success',
          title: 'Checkpoint restored',
          message: `Restored ${result.value.restoredFiles.length} file${
            result.value.restoredFiles.length === 1 ? '' : 's'
          }.`
        })
      }
      return result.value
    },

    syncCheckpointSummary: (conversationId, messageId, checkpoint) => {
      let changed = false
      const updatedAt = Date.now()
      set((state) => {
        const conversation = state.conversations.find((item) => item.id === conversationId)
        const message = conversation?.messages.find((item) => item.id === messageId)
        if (!conversation || !message) return
        message.checkpoint = checkpoint
        conversation.updatedAt = updatedAt
        changed = true
      })
      if (!changed) return
      const conversation = get().conversations.find((item) => item.id === conversationId)
      if (conversation) void persistConversation(conversation)
    }
  }))
)

function ensureChatReady(): boolean {
  const engine = useModelStore.getState().engine
  const settings = useSettingsStore.getState().settings
  if (isChatReady(settings, engine.status)) return true

  const provider = settings?.provider.active
  if (provider === 'anthropic' || provider === 'openai') {
    const providerLabel = provider === 'anthropic' ? 'Claude' : 'OpenAI'
    notifyError(
      'No API key configured',
      `Add a ${providerLabel} API key in Settings → AI & Models to start chatting.`
    )
  } else {
    notifyError('No model loaded', 'Load a model in Settings → AI & Models to start chatting.')
  }
  return false
}

async function rehydrateAttachments(
  attachments: ChatAttachment[]
): Promise<ComposerAttachment[] | null> {
  try {
    return await Promise.all(
      attachments.map(async (attachment) => {
        let readPath = attachment.path
        if (!isAbsoluteAttachmentPath(readPath)) {
          const resolved = await anodex.workspace.getAbsolutePath(readPath)
          if (!resolved.ok) throw new Error(resolved.error.message)
          readPath = resolved.value
        }

        const result = await anodex.attachments.readFile(readPath)
        if (!result.ok) throw new Error(result.error.message)
        return result.value.kind === 'image'
          ? {
              kind: 'image' as const,
              path: attachment.path,
              name: attachment.name,
              dataUrl: result.value.dataUrl,
              mimeType: result.value.mimeType,
              sizeBytes: result.value.sizeBytes
            }
          : {
              kind: 'text' as const,
              path: attachment.path,
              name: attachment.name,
              content: result.value.content,
              sizeBytes: result.value.sizeBytes,
              truncated: result.value.truncated
            }
      })
    )
  } catch (error) {
    notifyError(
      'Could not reopen attachment',
      error instanceof Error ? error.message : 'The original attachment is no longer available.'
    )
    return null
  }
}

async function generateConversationTitle({
  conversationId,
  expectedTitle,
  userPrompt,
  assistantReply,
  attachmentNames,
  editedFiles
}: {
  conversationId: string
  expectedTitle: string
  userPrompt: string
  assistantReply: string
  attachmentNames: string[]
  editedFiles: string[]
}): Promise<void> {
  const title = await anodex.chat
    .title({ userPrompt, assistantReply, attachmentNames, editedFiles })
    .catch(() => null)
  const nextTitle = title?.trim()
  if (!nextTitle) return

  const current = useChatStore.getState().conversations.find((c) => c.id === conversationId)
  if (!current || current.title !== expectedTitle) return

  useChatStore.setState((state) => {
    const conversation = state.conversations.find((c) => c.id === conversationId)
    if (conversation && conversation.title === expectedTitle) conversation.title = nextTitle
  })

  const nextConversation = useChatStore
    .getState()
    .conversations.find((c) => c.id === conversationId)
  if (nextConversation) await persistConversation(nextConversation)
}

function editedFilesForAssistantMessage(conversation: Conversation, messageId: string): string[] {
  const message = conversation.messages.find((item) => item.id === messageId)
  return Array.from(
    new Set(
      (message?.toolCalls ?? [])
        .map((call) => call.diff?.path)
        .filter((path): path is string => Boolean(path))
    )
  )
}

function deriveTitle(text: string): string {
  const firstLine = text.split('\n')[0].trim()
  return firstLine.length > 44 ? `${firstLine.slice(0, 44)}…` : firstLine || DEFAULT_TITLE
}
