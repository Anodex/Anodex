import { create } from 'zustand'
import type {
  EngineState,
  ModelDownloadProgress,
  ModelInfo,
  ModelLoadRecovery
} from '@shared/model.types'
import type { RecommendedModel } from '@shared/recommendedModels'
import { anodex } from '../lib/anodex'
import { notifyError, useUiStore } from './uiStore'
import { useSettingsStore } from './settingsStore'
import { resolveModelContextSize } from '@shared/modelContextSize'

const INITIAL_ENGINE: EngineState = { status: 'unloaded', generating: false, vision: false }

interface ModelState {
  models: ModelInfo[]
  engine: EngineState
  /** Path of the model currently being loaded, for per-card spinners. */
  pendingPath: string | null
  /** In-progress/most-recent download per `RecommendedModel.id`. */
  downloads: Record<string, ModelDownloadProgress>
  /**
   * Set when the previous run died loading a model. While it is set, nothing
   * auto-loads — the whole point is to break the crash loop and let the user
   * choose.
   */
  loadRecovery: ModelLoadRecovery | null
  refresh: () => Promise<void>
  addModel: () => Promise<void>
  addVisionProjector: (model: ModelInfo) => Promise<void>
  loadModel: (model: ModelInfo, overrides?: ModelLoadOverrides) => Promise<void>
  unloadModel: () => Promise<void>
  deleteModel: (model: ModelInfo) => Promise<void>
  downloadModel: (model: RecommendedModel) => Promise<void>
  cancelDownload: (modelId: string) => void
  /** Called by the IPC bridge when the engine broadcasts a new state. */
  setEngineState: (state: EngineState) => void
  /** Called by the IPC bridge when a download reports progress. */
  setDownloadProgress: (progress: ModelDownloadProgress) => void
  /** Ask the main process whether the previous run crashed mid-load. */
  checkLoadRecovery: () => Promise<ModelLoadRecovery | null>
  /** Load the crashed model under the recovery's safer settings, and keep them. */
  retryLoadSafely: () => Promise<void>
  /** Load the crashed model again unchanged, at the user's explicit request. */
  retryLoadUnchanged: () => Promise<void>
  /** Answer the recovery prompt without loading anything. */
  dismissLoadRecovery: () => void
  /** Clear the "didn't load X" notice once the user has answered it. */
  dismissLoadRefusal: () => void
}

/** Per-load settings that override the saved defaults for one attempt. */
interface ModelLoadOverrides {
  contextSize?: number
  gpuLayers?: number | 'auto'
}

/** Local model catalogue plus the live engine state. */
export const useModelStore = create<ModelState>((set, get) => ({
  models: [],
  engine: INITIAL_ENGINE,
  pendingPath: null,
  downloads: {},
  loadRecovery: null,

  refresh: async () => {
    const result = await anodex.models.list()
    if (result.ok) set({ models: result.value })
    else notifyError('Could not load models', result.error.message)
  },

  addModel: async () => {
    const result = await anodex.models.add()
    if (!result.ok) {
      notifyError('Could not add model', result.error.message)
      return
    }
    if (result.value) {
      await get().refresh()
      useUiStore.getState().notify({
        kind: 'success',
        title: 'Model added',
        message: result.value.name
      })
    }
  },

  addVisionProjector: async (model) => {
    const shouldReload = get().engine.model?.path === model.path && get().engine.status === 'ready'
    if (shouldReload && get().engine.generating) {
      notifyError('Model is busy', 'Stop the current reply before enabling vision.')
      return
    }
    const result = await anodex.models.addVisionProjector(model.path)
    if (!result.ok) {
      notifyError('Could not add vision projector', result.error.detail ?? result.error.message)
      return
    }
    if (!result.value) return
    await get().refresh()
    if (shouldReload) {
      const unloaded = await anodex.models.unload()
      if (!unloaded.ok) {
        notifyError('Could not reload model', unloaded.error.message)
        return
      }
      set({ engine: unloaded.value })
      await get().loadModel(result.value)
      return
    }
    useUiStore.getState().notify({
      kind: 'success',
      title: 'Vision enabled',
      message: `${model.name} can now accept images.`
    })
  },

  loadModel: async (model, overrides) => {
    const settings = useSettingsStore.getState().settings
    // Per-model before global — see `resolveModelContextSize` for why a size
    // chosen for one model must not follow the next one into the engine.
    const contextSize = resolveModelContextSize(settings, model.path, overrides?.contextSize)
    set({ pendingPath: model.path })
    try {
      const result = await anodex.models.load({
        path: model.path,
        visionProjectorPath: model.visionProjectorPath,
        contextSize,
        gpuLayers: overrides?.gpuLayers ?? settings?.model.gpuLayers
      })

      if (result.ok) {
        set({ engine: result.value })
        // Keep the single number the settings UI shows honest about what is
        // actually running, now that a remembered per-model size can differ
        // from the global one.
        void useSettingsStore.getState().update({
          lastModelPath: model.path,
          ...(contextSize !== undefined && contextSize !== settings?.model.contextSize
            ? { model: { contextSize } }
            : {})
        })
        useUiStore.getState().notify({ kind: 'success', title: 'Model ready', message: model.name })
      } else {
        notifyError('Failed to load model', result.error.detail ?? result.error.message)
      }
    } catch (error) {
      // A rejection at the IPC layer never becomes the handler's own `err`
      // result, and this is called as `void loadModel(...)` from several
      // places, so it used to escape as an unhandled rejection with nothing
      // said to the user.
      notifyError(
        'Failed to load model',
        error instanceof Error ? error.message : 'The request failed.'
      )
    } finally {
      // Cleared whatever happened. This drives the per-card spinner, so leaving
      // it set on a failure left that model's card spinning for the rest of the
      // session over a load that had already given up.
      set({ pendingPath: null })
    }
  },

  unloadModel: async () => {
    const result = await anodex.models.unload()
    if (result.ok) set({ engine: result.value })
    else notifyError('Failed to unload model', result.error.message)
  },

  deleteModel: async (model) => {
    const result = await anodex.models.delete(model.path)
    if (!result.ok) {
      notifyError('Could not delete model', result.error.detail ?? result.error.message)
      return
    }
    if (get().engine.model?.path === model.path) {
      set({ engine: { status: 'unloaded', generating: false, vision: false } })
    }
    await get().refresh()
    useUiStore.getState().notify({ kind: 'success', title: 'Model deleted', message: model.name })
  },

  downloadModel: async (model) => {
    set((s) => ({
      downloads: {
        ...s.downloads,
        [model.id]: { modelId: model.id, receivedBytes: 0, totalBytes: null, status: 'downloading' }
      }
    }))

    /**
     * Record how the download ended.
     *
     * The main process streams progress while a download runs but broadcasts
     * nothing terminal when one fails — its handler catches and returns an
     * `err` result instead. So a failure left this entry sitting at
     * `status: 'downloading'` for the rest of the session, and every card
     * reading it (`ModelDownloadIcon` on the discover panel, the recommended
     * strip, and the empty state) went on showing a download in progress that
     * had already given up.
     */
    const settle = (status: ModelDownloadProgress['status'], error?: string): void => {
      set((s) => {
        const current = s.downloads[model.id]
        // A terminal broadcast that arrived first wins: it carries real byte
        // counts, where this only knows the outcome.
        if (!current || current.status !== 'downloading') return s
        return { downloads: { ...s.downloads, [model.id]: { ...current, status, error } } }
      })
    }

    try {
      const result = await anodex.models.download(model)
      if (!result.ok) {
        settle('error', result.error.detail ?? result.error.message)
        notifyError('Failed to download model', result.error.detail ?? result.error.message)
        return
      }
      settle('done')
      await get().refresh()
      useUiStore
        .getState()
        .notify({ kind: 'success', title: 'Model downloaded', message: result.value.name })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The request failed.'
      settle('error', message)
      notifyError('Failed to download model', message)
    }
  },

  cancelDownload: (modelId) => {
    void anodex.models.cancelDownload(modelId)
  },

  setEngineState: (state) => set({ engine: state }),

  setDownloadProgress: (progress) =>
    set((s) => ({ downloads: { ...s.downloads, [progress.modelId]: progress } })),

  checkLoadRecovery: async () => {
    const recovery = await anodex.models.getLoadRecovery()
    set({ loadRecovery: recovery })
    return recovery
  },

  retryLoadSafely: async () => {
    const recovery = get().loadRecovery
    if (!recovery) return
    get().dismissLoadRecovery()

    // Persist the safer settings before loading, not after. If this attempt
    // crashes too, the next launch has to auto-restore under the reduced
    // settings rather than the ones already known to crash. `contextSize` is
    // only included when the recovery actually named one — the patch merge
    // treats a present-but-undefined key as a real value and would blank the
    // saved size.
    await useSettingsStore.getState().update({
      model: {
        gpuLayers: recovery.retry.gpuLayers,
        ...(recovery.retry.contextSize !== undefined
          ? { contextSize: recovery.retry.contextSize }
          : {})
      }
    })

    const model = get().models.find((m) => m.path === recovery.interrupted.modelPath)
    if (!model) {
      notifyError('Model file is missing', recovery.interrupted.modelPath)
      return
    }
    await get().loadModel(model, recovery.retry)
  },

  retryLoadUnchanged: async () => {
    const recovery = get().loadRecovery
    if (!recovery) return
    get().dismissLoadRecovery()

    const model = get().models.find((m) => m.path === recovery.interrupted.modelPath)
    if (!model) {
      notifyError('Model file is missing', recovery.interrupted.modelPath)
      return
    }
    await get().loadModel(model, {
      gpuLayers: recovery.interrupted.gpuLayers,
      contextSize: recovery.interrupted.contextSize
    })
  },

  dismissLoadRecovery: () => {
    set({ loadRecovery: null })
    void anodex.models.dismissLoadRecovery()
  },

  dismissLoadRefusal: () => {
    // Cleared locally first so the notice disappears on the click rather than
    // on the round-trip; main broadcasts the same cleared state right after.
    const { engine } = get()
    if (engine.refusedLoad) set({ engine: { ...engine, refusedLoad: undefined } })
    void anodex.models.dismissLoadRefusal()
  }
}))
