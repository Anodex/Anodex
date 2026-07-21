import { useEffect } from 'react'
import { recommendModel } from '@shared/modelRecommendation'
import { anodex } from '../lib/anodex'
import { notifyDesktop, shouldShowDesktopToast } from '../lib/notifications'
import { playChime } from '../lib/sound'
import { useChatStore } from '../stores/chatStore'
import { useModelStore } from '../stores/modelStore'
import { useProjectStore } from '../stores/projectStore'
import { useProviderUsageStore } from '../stores/providerUsageStore'
import { useSchedulerStore } from '../stores/schedulerStore'
import { useAgentStore } from '../stores/agentStore'
import { useCriticalThinkingStore } from '../stores/criticalThinkingStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useMcpStore } from '../stores/mcpStore'
import { useStartupStore } from '../stores/startupStore'
import { useUiStore } from '../stores/uiStore'
import { TokenBatcher } from './tokenBatcher'

/**
 * The active project (main process) and the active conversation's own
 * `projectId` (renderer) are persisted independently. Resync them on launch
 * so a restored general chat never silently inherits a project left active
 * from a previous session — the same invariant `Sidebar.tsx` maintains
 * during normal use when creating or selecting a chat.
 */
async function reconcileActiveProject(): Promise<void> {
  // A conversation can keep pointing at a project that no longer exists —
  // e.g. an interrupted delete, or data left over from an older build.
  // Heal those first so they settle into general chats instead of making
  // every launch retry (and fail) activating a dead project.
  const projectIds = new Set(useProjectStore.getState().projects.map((p) => p.id))
  const orphaned = useChatStore
    .getState()
    .conversations.filter((c) => c.projectId !== null && !projectIds.has(c.projectId))
  for (const conversation of orphaned) {
    await useChatStore.getState().clearOrphanedProjectId(conversation.id)
  }

  const { conversations, activeId } = useChatStore.getState()
  const activeConversation = conversations.find((c) => c.id === activeId)
  const expectedProjectId = activeConversation?.projectId ?? null
  if (useProjectStore.getState().activeProjectId !== expectedProjectId) {
    await useProjectStore.getState().setActive(expectedProjectId)
  }
}

/**
 * Delay before auto-restoring the last-used model at launch, giving the
 * window a moment to finish showing before the native engine starts
 * allocating GPU/model resources. Kept as a small secondary safety margin —
 * the actual startup-crash root cause was a genuine double model-load race
 * (see the comment in `useAnodexBridge`), which is now fixed at the source;
 * this delay is no longer load-bearing for correctness, just a courtesy.
 */
const STARTUP_MODEL_LOAD_DELAY_MS = 3000

/**
 * Connects the main-process event streams to the renderer stores and performs
 * the one-time initial data load. Mounted once at the app root.
 */
export function useAnodexBridge(): void {
  useEffect(() => {
    // React StrictMode intentionally mounts, cleans up, then re-mounts every
    // effect once in development to surface exactly this class of bug: an
    // untracked `setTimeout` scheduled inside `hydrate()` used to survive the
    // first mount's cleanup, so the delayed `restoreLastModel()` call fired
    // twice — the actual cause of both the duplicate "model ready" toast and,
    // almost certainly, the intermittent native startup crash (two concurrent
    // `loadModel()` calls racing to allocate the same GPU/model resources).
    // Owning the timer here — cancelled on cleanup — makes a re-mount a no-op
    // instead of a second real load.
    let cancelled = false
    let restoreTimer: ReturnType<typeof setTimeout> | undefined

    void hydrate()
      .then(() => {
        if (cancelled) return
        // Readiness for the startup overlay is hydrate() resolving — the
        // deferred model load below is deliberately NOT part of it (model
        // loading must never block app entry; the model status chip in the
        // sidebar carries any load still in flight).
        useStartupStore.getState().setReady()
        restoreTimer = setTimeout(() => void restoreLastModel(), STARTUP_MODEL_LOAD_DELAY_MS)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        useStartupStore
          .getState()
          .setError(
            "Couldn't finish starting Anodex",
            error instanceof Error ? error.message : String(error)
          )
      })

    // Live subscriptions.
    //
    // Token/thinking-token IPC events are coalesced (via `TokenBatcher`) into
    // at most one chat-store commit per animation frame instead of one per
    // raw token. A long bounded-chat reply (see BoundedChatRunner) can grow
    // to 80+ tool calls and tens of thousands of characters in one message;
    // MessageBubble's own render pipeline (sanitizeMessageTranscript →
    // messageBlocks → buildRenderSegments → groupSegmentsForTimeline)
    // necessarily reprocesses the WHOLE message from scratch on every call,
    // since each one genuinely has new content. Committing a state update —
    // and so triggering that full reprocessing — on every single raw token
    // (many per second) made that whole-message cost recur far more often
    // than the display could even show, observed directly as the renderer's
    // main thread pegged long enough for Windows to mark the window "Not
    // Responding" during exactly these long tool-heavy runs. Batching only
    // reduces how OFTEN the full reprocessing recurs, not what one
    // recurrence costs — and it's self-correcting if a frame really is slow:
    // the next `requestAnimationFrame` callback still fires whenever the
    // thread frees up, coalescing whatever arrived in the meantime into one
    // bigger flush, rather than queuing ever-more-granular commits behind it.
    const tokenBatcher = new TokenBatcher()
    let tokenFlushHandle: number | null = null
    const flushPendingTokens = (): void => {
      tokenFlushHandle = null
      const { tokens, thinkingTokens } = tokenBatcher.drain()
      for (const [messageId, { conversationId, text }] of tokens) {
        useChatStore.getState().appendToken(conversationId, messageId, text)
      }
      for (const [messageId, { conversationId, text }] of thinkingTokens) {
        useChatStore.getState().appendThinkingToken(conversationId, messageId, text)
      }
    }
    const scheduleTokenFlush = (): void => {
      if (tokenFlushHandle !== null) return
      tokenFlushHandle = requestAnimationFrame(flushPendingTokens)
    }

    const offStream = anodex.chat.onStream(({ conversationId, messageId, token }) => {
      tokenBatcher.addToken(conversationId, messageId, token)
      scheduleTokenFlush()
    })
    const offThinkingStream = anodex.chat.onThinkingStream(
      ({ conversationId, messageId, token }) => {
        tokenBatcher.addThinkingToken(conversationId, messageId, token)
        scheduleTokenFlush()
      }
    )
    const offEngine = anodex.models.onStateChanged((state) =>
      useModelStore.getState().setEngineState(state)
    )
    const offDownloadProgress = anodex.models.onDownloadProgress((progress) =>
      useModelStore.getState().setDownloadProgress(progress)
    )
    const offToolActivity = anodex.tools.onActivity((event) =>
      useChatStore.getState().applyToolActivity(event)
    )
    const offConfirm = anodex.tools.onConfirmRequest((request) => {
      useUiStore.getState().addPendingConfirmation(request)
      if (shouldShowDesktopToast()) {
        playChime('attention')
        notifyDesktop('Approval needed', request.title)
      }
    })
    // Main already answered this request on its own (the generation was
    // aborted while it was still awaiting a decision) — drop the now-dead
    // card instead of leaving an approval prompt no click will ever resolve.
    const offConfirmCancelled = anodex.tools.onConfirmCancelled((id) => {
      useUiStore.getState().dismissCancelledConfirmation(id)
    })
    const offProviderUsage = anodex.provider.onUsageChanged((snapshot) =>
      useProviderUsageStore.getState().setSnapshot(snapshot)
    )
    const offHistoryCompacted = anodex.chat.onHistoryCompacted((event) => {
      useChatStore.getState().applyHistoryCompaction(event)
      const turnWord = `${event.removedTurns} earlier turn${event.removedTurns === 1 ? '' : 's'}`
      useUiStore.getState().notify({
        kind: 'info',
        title: 'Conversation compacted',
        message: event.summarized
          ? `Summarized ${turnWord} to stay within the model's context window.`
          : `Dropped ${turnWord} to stay within the model's context window.`
      })
    })
    const offSchedulerTasks = anodex.scheduler.onTasksChanged((tasks) => {
      useSchedulerStore.getState().setTasks(tasks)
      // A task run creates or appends to its own conversation in the main
      // process without the renderer ever calling `chat.send` — refresh the
      // list so a task's chat/badge shows up without a manual reload.
      void useChatStore.getState().refreshConversations()
    })
    const offAgentRuns = anodex.agent.onRunsChanged((runs) => {
      useAgentStore.getState().setRuns(runs)
      // A run creates or appends to its own conversation in the main process
      // without the renderer ever calling `chat.send` — refresh the list so
      // its chat/badge shows up without a manual reload.
      void useChatStore.getState().refreshConversations()
    })
    const offCriticalThinkingStream = anodex.criticalThinking.onStream(({ runId, token }) => {
      useCriticalThinkingStore.getState().appendToken(runId, token)
    })
    const offCriticalThinkingRuns = anodex.criticalThinking.onRunsChanged((runs) => {
      useCriticalThinkingStore.getState().setRuns(runs)
    })
    const offMcpStatus = anodex.mcp.onStatusChanged((state) => {
      useMcpStore.getState().setStatus(state)
    })
    // Clicking a scheduled-task toast asks the main window to open the
    // conversation that run produced, instead of just focusing whatever view
    // already happened to be showing.
    const offToastOpenConversation = anodex.toast.onOpenConversation((conversationId) => {
      const conversation = useChatStore
        .getState()
        .conversations.find((c) => c.id === conversationId)
      void useProjectStore.getState().setActive(conversation?.projectId ?? null)
      void useChatStore.getState().selectConversation(conversationId)
      useUiStore.getState().setView('chat')
    })

    return () => {
      cancelled = true
      if (restoreTimer) clearTimeout(restoreTimer)
      if (tokenFlushHandle !== null) cancelAnimationFrame(tokenFlushHandle)
      offStream()
      offThinkingStream()
      offEngine()
      offDownloadProgress()
      offToolActivity()
      offConfirm()
      offConfirmCancelled()
      offProviderUsage()
      offHistoryCompacted()
      offSchedulerTasks()
      offAgentRuns()
      offCriticalThinkingStream()
      offCriticalThinkingRuns()
      offMcpStatus()
      offToastOpenConversation()
    }
  }, [])
}

async function hydrate(): Promise<void> {
  const status = (text: string): void => useStartupStore.getState().setStatus(text)

  status('Loading settings')
  await useSettingsStore.getState().load()
  // Detected before autoConfigureFromHardware flips the flag: a first launch
  // gets the slightly longer, more cinematic startup sequence.
  if (useSettingsStore.getState().settings?.model.autoConfigured === false) {
    useStartupStore.getState().markFirstLaunch()
  }

  status('Restoring workspace')
  await useProjectStore.getState().load()
  await useChatStore.getState().load()
  await reconcileActiveProject()

  status('Checking local models')
  await autoConfigureFromHardware()
  await useModelStore.getState().refresh()
  const state = await anodex.models.getState()
  useModelStore.getState().setEngineState(state)

  status('Connecting services')
  const usage = await anodex.provider.getUsageSnapshot()
  useProviderUsageStore.getState().setAll(usage)
  await useSchedulerStore.getState().load()
  await useAgentStore.getState().load()
  await useCriticalThinkingStore.getState().load()
  await useMcpStore.getState().load()
}

/**
 * Re-run the startup hydration after a failure, from the overlay's
 * "Try again" action. A successful retry also schedules the deferred model
 * restore that the original mount-time path would have scheduled.
 */
export async function retryStartup(): Promise<void> {
  useStartupStore.getState().beginAttempt()
  try {
    await hydrate()
    useStartupStore.getState().setReady()
    setTimeout(() => void restoreLastModel(), STARTUP_MODEL_LOAD_DELAY_MS)
  } catch (error) {
    useStartupStore
      .getState()
      .setError(
        "Couldn't finish starting Anodex",
        error instanceof Error ? error.message : String(error)
      )
  }
}

/**
 * On first launch, seed context/GPU/token defaults from the detected hardware so
 * the app is tuned to the user's machine out of the box. Runs once (guarded by
 * `model.autoConfigured`); never overrides the user's later manual choices.
 */
async function restoreLastModel(): Promise<void> {
  const settings = useSettingsStore.getState().settings
  const lastPath = settings?.lastModelPath
  if (!lastPath) return

  const models = useModelStore.getState().models
  const model = models.find((m) => m.path === lastPath)
  if (!model) {
    await useSettingsStore.getState().update({ lastModelPath: undefined })
    return
  }

  await useModelStore.getState().loadModel(model)
}

async function autoConfigureFromHardware(): Promise<void> {
  const settings = useSettingsStore.getState().settings
  if (!settings || settings.model.autoConfigured) return
  try {
    const hw = await anodex.system.getHardwareInfo()
    const rec = recommendModel({
      ramBytes: hw.ramBytes,
      vramBytes: hw.vramBytes,
      unified: hw.unifiedMemory
    })
    await useSettingsStore.getState().update({
      model: { contextSize: rec.contextSize, gpuLayers: rec.gpuLayers, autoConfigured: true },
      generation: { maxTokens: rec.maxTokens }
    })
  } catch {
    // Non-fatal — keep the static defaults if detection fails.
  }
}
