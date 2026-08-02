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
    set({ pendingPath: model.path })
    const result = await anodex.models.load({
      path: model.path,
      visionProjectorPath: model.visionProjectorPath,
      contextSize: overrides?.contextSize ?? settings?.model.contextSize,
      gpuLayers: overrides?.gpuLayers ?? settings?.model.gpuLayers
    })
    set({ pendingPath: null })

    if (result.ok) {
      set({ engine: result.value })
      void useSettingsStore.getState().update({ lastModelPath: model.path })
      useUiStore.getState().notify({ kind: 'success', title: 'Model ready', message: model.name })
    } else {
      notifyError('Failed to load model', result.error.detail ?? result.error.message)
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
    const result = await anodex.models.download(model)
    if (!result.ok) {
      notifyError('Failed to download model', result.error.detail ?? result.error.message)
      return
    }
    await get().refresh()
    useUiStore
      .getState()
      .notify({ kind: 'success', title: 'Model downloaded', message: result.value.name })
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
