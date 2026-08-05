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
import { useEmailStore } from '../stores/emailStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useMcpStore } from '../stores/mcpStore'
import { useDiagnosticsStore } from '../stores/diagnosticsStore'
import { useStartupStore } from '../stores/startupStore'
import { useUiStore } from '../stores/uiStore'
import { deferredModelRestore } from './deferredRestore'
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

    void hydrate()
      .then(() => {
        if (cancelled) return
        // Readiness for the startup overlay is hydrate() resolving — the
        // deferred model load below is deliberately NOT part of it (model
        // loading must never block app entry; the model status chip in the
        // sidebar carries any load still in flight).
        useStartupStore.getState().setReady()
        deferredModelRestore.schedule(() => void restoreLastModel(), STARTUP_MODEL_LOAD_DELAY_MS)
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
    // Token/thinking-token/tool-activity IPC events are all coalesced (via
    // `TokenBatcher`) into at most one chat-store commit per animation frame
    // instead of one per raw event. A long bounded-chat reply (see
    // BoundedChatRunner) can grow to 80+ tool calls and tens of thousands of
    // characters in one message; MessageBubble's own render pipeline
    // (sanitizeMessageTranscript → messageBlocks → buildRenderSegments →
    // groupSegmentsForTimeline) necessarily reprocesses the WHOLE message
    // from scratch on every call, since each one genuinely has new content.
    // Committing a state update — and so triggering that full reprocessing —
    // on every single raw token (many per second) OR every single tool
    // running/success/error event (a model calling many read-only tools back
    // to back with little text between them is just as hot a path) made
    // that whole-message cost recur far more often than the display could
    // even show, observed directly as the renderer's main thread pegged long
    // enough for Windows to mark the window "Not Responding" during exactly
    // these long tool-heavy runs — including after batching only the token
    // stream first, since the burst of tool-activity events was still each
    // committing separately. Batching only reduces how OFTEN the full
    // reprocessing recurs, not what one recurrence costs — and it's self-
    // correcting if a frame really is slow: the next `requestAnimationFrame`
    // callback still fires whenever the thread frees up, coalescing
    // whatever arrived in the meantime into one bigger flush, rather than
    // queuing ever-more-granular commits behind it.
    const tokenBatcher = new TokenBatcher()
    let tokenFlushHandle: number | null = null
    const flushPendingTokens = (): void => {
      tokenFlushHandle = null
      const { tokens, thinkingTokens, activity } = tokenBatcher.drain()
      // Activity first: `applyToolActivityBatch` clears this message's
      // streaming-tool-payload quarantine (see `quarantineStreamingToolPayload`)
      // the moment a real tool call is confirmed, so a token batch flushed in
      // this same frame sees that already cleared rather than staying
      // quarantined for one extra frame.
      for (const [messageId, conversationId, calls] of activity) {
        useChatStore.getState().applyToolActivityBatch(conversationId, messageId, calls)
      }
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
    const offToolActivity = anodex.tools.onActivity(({ conversationId, messageId, call }) => {
      tokenBatcher.addToolActivity(conversationId, messageId, call)
      scheduleTokenFlush()
    })
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
    // Background-service warnings and errors (local engine, mailboxes, MCP,
    // updater, crash handlers) are recorded in the main process. Replay the
    // backlog first — startup failures happen before this window exists, and a
    // renderer crash means the live broadcast had nowhere to go — then follow
    // along live.
    const offDiagnosticEntry = anodex.diagnostics.onEntry((entry) => {
      useDiagnosticsStore.getState().ingest([entry])
    })
    void anodex.diagnostics
      .list()
      .then((entries) => {
        if (cancelled) return
        useDiagnosticsStore.getState().ingest(entries)
      })
      // Every other startup call is inside `hydrate`, which has a catch. This
      // one runs beside the subscriptions, so a failure here had nowhere to go.
      .catch(() => {
        /* The live subscription above still carries anything new. */
      })
    // Alt-tabbing repeatedly used to start a full mailbox load each time. The
    // store's own revision guard keeps the *state* consistent, but every one of
    // those still went out to IMAP or Graph — so a slow account was hammered by
    // nothing more than switching windows. Skipping while one is in flight
    // costs no freshness: the request already running returns the same thing.
    let emailRefresh: Promise<void> | null = null
    const refreshEmailOnFocus = (): void => {
      if (emailRefresh) return
      emailRefresh = useEmailStore
        .getState()
        .load()
        .finally(() => {
          emailRefresh = null
        })
    }
    window.addEventListener('focus', refreshEmailOnFocus)
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
      deferredModelRestore.cancel()
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
      offDiagnosticEntry()
      offToastOpenConversation()
      window.removeEventListener('focus', refreshEmailOnFocus)
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
  // Gmail can require a token refresh and network round trip. Let its sidebar
  // count arrive independently instead of holding the startup screen open.
  void useEmailStore.getState().load()
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
    deferredModelRestore.schedule(() => void restoreLastModel(), STARTUP_MODEL_LOAD_DELAY_MS)
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
 * Re-load whichever model was active when the app last closed, so a restart
 * lands the user back where they were instead of on an empty engine.
 */
async function restoreLastModel(): Promise<void> {
  // Before anything else: if the previous run died loading a model, restoring
  // it now is exactly how an app becomes permanently unlaunchable. Hand the
  // decision to the user instead — `SafeModeDialog` renders the prompt.
  // Checked ahead of `lastModelPath` on purpose, since a model that crashed on
  // its first load never became the last *successfully* loaded one.
  const recovery = await useModelStore.getState().checkLoadRecovery()
  if (recovery) return

  const settings = useSettingsStore.getState().settings
  const lastPath = settings?.lastModelPath
  if (!lastPath) return

  const models = useModelStore.getState().models
  const model = models.find((m) => m.path === lastPath)
  if (!model) {
    // `null`, not `undefined` — patches are deep-merged and `undefined` keys are
    // skipped, so the stale path would survive and be retried every launch.
    await useSettingsStore.getState().update({ lastModelPath: null })
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
      model: { contextSize: rec.contextSize, gpuLayers: rec.gpuLayers, autoConfigured: true }
    })
  } catch {
    // Non-fatal — keep the static defaults if detection fails.
  }
}
