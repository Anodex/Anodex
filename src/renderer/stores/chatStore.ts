import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { HistoryCompactionEvent } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'
import { TOOL_CATALOG, type ToolActivityEvent } from '@shared/tools.types'
import { stripToolCallText } from '@shared/toolCallText'
import { messageToHistoryTurn, sanitizeAssistantContent } from '@shared/chatSanitizer'
import { anodex } from '../lib/anodex'
import { createId } from '../lib/id'
import { notifyError, useUiStore } from './uiStore'
import { useSettingsStore } from './settingsStore'
import { useModelStore } from './modelStore'
import { playChime } from '../lib/sound'
import { notifyDesktop, shouldShowDesktopToast } from '../lib/notifications'
import { buildPromptWithAttachments, type ComposerAttachment } from '../lib/attachments'
import { reconcileMessageBlocks } from '../features/chat/reconcileMessageBlocks'
import { quarantineStreamingToolPayload } from '../features/chat/streamingToolPayload'
import { isChatReady } from '../lib/chatReadiness'

export type { Conversation }

/** A message queued from the composer while a turn is still streaming. */
export interface PendingMessage {
  id: string
  text: string
  attachments: ComposerAttachment[]
}

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
  newConversation: (projectId?: string | null) => string
  selectConversation: (id: string) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  restoreConversation: (id: string) => Promise<void>
  deleteConversationPermanent: (id: string) => Promise<void>
  /** Archive every active conversation (all projects and general chats). */
  deleteAllConversations: () => Promise<void>
  refreshConversations: () => Promise<void>
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
  /** Queue a message onto the active conversation while it's still generating. */
  queueMessage: (text: string, attachments?: ComposerAttachment[]) => void
  /** Cancel a queued message before it's auto-sent. */
  removeQueuedMessage: (conversationId: string, id: string) => void
  stopGeneration: () => Promise<void>
  /** Manually summarize older turns into the conversation's durable context snapshot. */
  compactConversation: () => Promise<void>
  /** Called by the IPC bridge for each streamed token. */
  appendToken: (conversationId: string, messageId: string, token: string) => void
  /** Called by the IPC bridge as the assistant's tool calls progress. */
  applyToolActivity: (event: ToolActivityEvent) => void
  /** Persist a durable context snapshot after the main process compacts history. */
  applyHistoryCompaction: (event: HistoryCompactionEvent) => void
}

const DEFAULT_TITLE = 'New chat'
const pendingToolPayloadByMessage = new Map<string, string>()

async function persistConversation(conversation: Conversation): Promise<void> {
  await anodex.conversations.save(conversation)
}

async function persistActiveState(activeId: string | null): Promise<void> {
  await anodex.conversations.setState({ activeConversationId: activeId })
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

    newConversation: (projectId = null) => {
      const id = createId('c')
      const now = Date.now()
      const conversation: Conversation = {
        id,
        projectId,
        title: DEFAULT_TITLE,
        messages: [],
        createdAt: now,
        updatedAt: now
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
      set((state) => {
        state.conversations = state.conversations.filter((c) => c.id !== id)
        if (state.activeId === id) state.activeId = state.conversations[0]?.id ?? null
      })
      await anodex.conversations.delete(id)
      await persistActiveState(get().activeId)
    },

    restoreConversation: async (id) => {
      await anodex.conversations.restore(id)
      const conversations = await anodex.conversations.list()
      set({ conversations })
    },

    deleteConversationPermanent: async (id) => {
      await anodex.conversations.deletePermanent(id)
      const conversations = await anodex.conversations.list()
      set({ conversations })
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
      const conversations = await anodex.conversations.list()
      set({ conversations })
    },

    sendMessage: async (text, attachments = [], conversationIdOverride) => {
      const trimmed = text.trim()
      if (!trimmed && attachments.length === 0) return

      const engine = useModelStore.getState().engine
      const settingsForReadyCheck = useSettingsStore.getState().settings
      if (!isChatReady(settingsForReadyCheck, engine.status)) {
        const providerActive = settingsForReadyCheck?.provider.active
        if (providerActive === 'anthropic' || providerActive === 'openai') {
          const providerLabel = providerActive === 'anthropic' ? 'Claude' : 'OpenAI'
          notifyError(
            'No API key configured',
            `Add a ${providerLabel} API key in Settings → AI & Models to start chatting.`
          )
        } else {
          notifyError(
            'No model loaded',
            'Load a model in Settings → AI & Models to start chatting.'
          )
        }
        return
      }

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
            ? attachments.map((a) => ({ path: a.path, name: a.name, sizeBytes: a.sizeBytes }))
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
      const result = await anodex.chat.send({
        conversationId,
        messageId: assistantId,
        projectId,
        systemPrompt: settings?.assistantStyle.globalStyle,
        context: existing?.context ?? null,
        history,
        prompt: buildPromptWithAttachments(trimmed, attachments),
        plan: existing?.plan ?? null,
        options: settings
          ? {
              temperature: settings.generation.temperature,
              topP: settings.generation.topP,
              maxTokens: settings.generation.maxTokens
            }
          : undefined
      })

      set((state) => {
        const convo = state.conversations.find((c) => c.id === conversationId)
        const message = convo?.messages.find((m) => m.id === assistantId)
        if (!convo || !message) return
        pendingToolPayloadByMessage.delete(assistantId)
        message.streaming = false
        if (result.ok) {
          const content = sanitizeAssistantContent(result.value.content)
          message.content = content
          message.stats = result.value.stats
          message.blocks = reconcileMessageBlocks(
            message.blocks,
            content,
            message.toolCalls,
            [],
            trimmed,
            Boolean(projectId)
          )
          if (result.value.memoryUsed?.length) message.memoryUsed = result.value.memoryUsed
          if (result.value.transcriptRecallUsed?.length) {
            message.transcriptRecallUsed = result.value.transcriptRecallUsed
          }
        } else {
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
        convo.context = {
          activeSnapshot: {
            id: createId('ctx'),
            ...compacted.snapshot
          }
        }
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
        if (message && convo) {
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
        }
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

    applyToolActivity: ({ conversationId, messageId, call }) => {
      pendingToolPayloadByMessage.delete(messageId)
      set((state) => {
        const convo = state.conversations.find((c) => c.id === conversationId)
        const message = convo?.messages.find((m) => m.id === messageId)
        if (!message || !convo) return
        if (!message.toolCalls) message.toolCalls = []
        const index = message.toolCalls.findIndex((c) => c.id === call.id)
        if (index >= 0) message.toolCalls[index] = call
        else message.toolCalls.push(call)

        // Mirror into the ordered timeline: a status update to an already-
        // placed call updates it in place; a new call id lands at the end,
        // which is exactly the right chronological spot since activity
        // events arrive in the order they occurred.
        if (!message.blocks) message.blocks = []
        const block = message.blocks.find((b) => b.type === 'tool' && b.call.id === call.id)
        if (block && block.type === 'tool') block.call = call
        else message.blocks.push({ type: 'tool', call })

        // A plan tool's activity event carries a full snapshot of the
        // conversation's plan — mirror it onto the conversation itself so the
        // Workspace Dock's Plan panel updates live, independent of which
        // message/tool card it came from.
        if (call.plan) convo.plan = call.plan
      })
      // convo.updatedAt is deliberately not touched here — see the comment in
      // `appendToken` above; a turn with many tool calls is just as hot a
      // path as one with many tokens.
      // Persisted when the generation completes in `sendMessage`.
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
        convo.context = {
          activeSnapshot: {
            id: createId('ctx'),
            createdAt: event.createdAt,
            reason: event.reason,
            throughMessageId,
            removedTurns: event.removedTurns,
            summary
          }
        }
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
      if (event.reason === 'proactive' || event.reason === 'reactive') {
        useUiStore.getState().notify({
          kind: 'info',
          title: 'Chat context compacted',
          message: `This conversation reached the model's context limit — summarized ${
            event.removedTurns
          } older turn${event.removedTurns === 1 ? '' : 's'} to keep going.`
        })
      }
    }
  }))
)

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
