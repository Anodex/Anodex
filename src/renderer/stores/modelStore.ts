import { create } from 'zustand'
import type { EngineState, ModelDownloadProgress, ModelInfo } from '@shared/model.types'
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
  refresh: () => Promise<void>
  addModel: () => Promise<void>
  addVisionProjector: (model: ModelInfo) => Promise<void>
  loadModel: (model: ModelInfo) => Promise<void>
  unloadModel: () => Promise<void>
  deleteModel: (model: ModelInfo) => Promise<void>
  downloadModel: (model: RecommendedModel) => Promise<void>
  cancelDownload: (modelId: string) => void
  /** Called by the IPC bridge when the engine broadcasts a new state. */
  setEngineState: (state: EngineState) => void
  /** Called by the IPC bridge when a download reports progress. */
  setDownloadProgress: (progress: ModelDownloadProgress) => void
}

/** Local model catalogue plus the live engine state. */
export const useModelStore = create<ModelState>((set, get) => ({
  models: [],
  engine: INITIAL_ENGINE,
  pendingPath: null,
  downloads: {},

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

  loadModel: async (model) => {
    const settings = useSettingsStore.getState().settings
    set({ pendingPath: model.path })
    const result = await anodex.models.load({
      path: model.path,
      visionProjectorPath: model.visionProjectorPath,
      contextSize: settings?.model.contextSize,
      gpuLayers: settings?.model.gpuLayers
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
    set((s) => ({ downloads: { ...s.downloads, [progress.modelId]: progress } }))
}))
