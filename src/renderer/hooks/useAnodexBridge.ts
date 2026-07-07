import { useEffect } from 'react'
import { recommendModel } from '@shared/modelRecommendation'
import { anodex } from '../lib/anodex'
import { notifyDesktop, shouldShowDesktopToast } from '../lib/notifications'
import { playChime } from '../lib/sound'
import { useChatStore } from '../stores/chatStore'
import { useModelStore } from '../stores/modelStore'
import { useProjectStore } from '../stores/projectStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUiStore } from '../stores/uiStore'

/**
 * The active project (main process) and the active conversation's own
 * `projectId` (renderer) are persisted independently. Resync them on launch
 * so a restored general chat never silently inherits a project left active
 * from a previous session — the same invariant `Sidebar.tsx` maintains
 * during normal use when creating or selecting a chat.
 */
async function reconcileActiveProject(): Promise<void> {
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

    void hydrate().then(() => {
      if (cancelled) return
      restoreTimer = setTimeout(() => void restoreLastModel(), STARTUP_MODEL_LOAD_DELAY_MS)
    })

    // Live subscriptions.
    const offStream = anodex.chat.onStream(({ conversationId, messageId, token }) =>
      useChatStore.getState().appendToken(conversationId, messageId, token)
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
      useUiStore.getState().setPendingConfirmation(request)
      if (shouldShowDesktopToast()) {
        playChime('attention')
        notifyDesktop('Approval needed', request.title)
      }
    })
    const offHistoryCompacted = anodex.chat.onHistoryCompacted(({ removedTurns, summarized }) => {
      const turnWord = `${removedTurns} earlier turn${removedTurns === 1 ? '' : 's'}`
      useUiStore.getState().notify({
        kind: 'info',
        title: 'Conversation compacted',
        message: summarized
          ? `Summarized ${turnWord} to stay within the model's context window.`
          : `Dropped ${turnWord} to stay within the model's context window.`
      })
    })

    return () => {
      cancelled = true
      if (restoreTimer) clearTimeout(restoreTimer)
      offStream()
      offEngine()
      offDownloadProgress()
      offToolActivity()
      offConfirm()
      offHistoryCompacted()
    }
  }, [])
}

async function hydrate(): Promise<void> {
  await useSettingsStore.getState().load()
  await useProjectStore.getState().load()
  await useChatStore.getState().load()
  await reconcileActiveProject()
  await autoConfigureFromHardware()
  await useModelStore.getState().refresh()
  const state = await anodex.models.getState()
  useModelStore.getState().setEngineState(state)
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
