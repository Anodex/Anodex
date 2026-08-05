import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '@shared/model.types'
import type { RecommendedModel } from '@shared/recommendedModels'

/**
 * First coverage for the local model catalogue and engine state. The two
 * defects it had are the same shape as the one round four found in
 * `emailStore`: a progress flag set before an await and cleared only on the
 * path that succeeded.
 */

const list = vi.fn<() => Promise<unknown>>()
const load = vi.fn<() => Promise<unknown>>()
const download = vi.fn<() => Promise<unknown>>()
const notify = vi.fn()
const notifyError = vi.fn()
const update = vi.fn()

vi.mock('../../lib/anodex', () => ({
  anodex: {
    models: {
      list,
      load,
      download,
      unload: vi.fn(),
      add: vi.fn(),
      addVisionProjector: vi.fn(),
      delete: vi.fn(),
      cancelDownload: vi.fn(),
      getLoadRecovery: vi.fn(),
      dismissLoadRecovery: vi.fn(),
      dismissLoadRefusal: vi.fn()
    }
  }
}))

vi.mock('../uiStore', () => ({
  notifyError,
  useUiStore: { getState: () => ({ notify }) }
}))

vi.mock('../settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: { model: {} }, update }) }
}))

const { useModelStore } = await import('../modelStore')
const initialState = useModelStore.getState()

function model(): ModelInfo {
  return { path: '/models/llama.gguf', name: 'llama', sizeBytes: 1 } as ModelInfo
}

function recommended(): RecommendedModel {
  return { id: 'rec-1', name: 'Recommended', family: 'llama' } as unknown as RecommendedModel
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

function err(message = 'boom'): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code: 'models.failed', message } }
}

beforeEach(() => {
  vi.clearAllMocks()
  useModelStore.setState(initialState, true)
  list.mockResolvedValue(ok([]))
})

describe('loadModel', () => {
  it('clears the per-card spinner after a successful load', async () => {
    load.mockResolvedValue(ok({ status: 'ready', generating: false, vision: false }))

    await useModelStore.getState().loadModel(model())

    expect(useModelStore.getState().pendingPath).toBeNull()
    expect(useModelStore.getState().engine.status).toBe('ready')
  })

  it('clears it when the load is refused', async () => {
    load.mockResolvedValue(err('not enough memory'))

    await useModelStore.getState().loadModel(model())

    expect(useModelStore.getState().pendingPath).toBeNull()
    expect(notifyError).toHaveBeenCalled()
  })

  /**
   * `pendingPath` drives the per-card spinner and was cleared on the line after
   * the await — which a rejection skips. One IPC-level failure left that
   * model's card spinning for the rest of the session, and the rejection itself
   * escaped unhandled because callers invoke this as `void loadModel(...)`.
   */
  it('clears it, and reports, when the request rejects outright', async () => {
    load.mockRejectedValue(new Error('bridge closed'))

    await useModelStore.getState().loadModel(model())

    expect(useModelStore.getState().pendingPath).toBeNull()
    expect(notifyError).toHaveBeenCalledWith('Failed to load model', 'bridge closed')
  })
})

describe('downloadModel', () => {
  it('marks the download done and refreshes the catalogue', async () => {
    download.mockResolvedValue(ok({ name: 'Recommended' }))

    await useModelStore.getState().downloadModel(recommended())

    expect(useModelStore.getState().downloads['rec-1'].status).toBe('done')
    expect(list).toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }))
  })

  /**
   * The main process streams progress while a download runs but broadcasts
   * nothing terminal when one fails — its handler catches and returns an `err`
   * result. So the entry stayed at `status: 'downloading'` and every card
   * reading it went on showing a download in progress that had already given up.
   */
  it('settles the entry when the download fails', async () => {
    download.mockResolvedValue(err('404 from the host'))

    await useModelStore.getState().downloadModel(recommended())

    expect(useModelStore.getState().downloads['rec-1']).toMatchObject({
      status: 'error',
      error: '404 from the host'
    })
    expect(notifyError).toHaveBeenCalled()
  })

  it('settles the entry when the request rejects outright', async () => {
    download.mockRejectedValue(new Error('bridge closed'))

    await useModelStore.getState().downloadModel(recommended())

    expect(useModelStore.getState().downloads['rec-1'].status).toBe('error')
  })

  // A terminal broadcast that arrived first carries real byte counts, where
  // settling only knows the outcome.
  it('does not overwrite a terminal state the main process already sent', async () => {
    download.mockImplementation(() => {
      useModelStore.getState().setDownloadProgress({
        modelId: 'rec-1',
        receivedBytes: 900,
        totalBytes: 900,
        status: 'canceled'
      })
      return Promise.resolve(err('cancelled'))
    })

    await useModelStore.getState().downloadModel(recommended())

    expect(useModelStore.getState().downloads['rec-1']).toMatchObject({
      status: 'canceled',
      receivedBytes: 900
    })
  })
})

describe('engine state', () => {
  it('takes what the bridge broadcasts', () => {
    useModelStore.getState().setEngineState({ status: 'ready', generating: true, vision: true })

    expect(useModelStore.getState().engine).toMatchObject({ status: 'ready', vision: true })
  })

  it('reports a catalogue it could not read', async () => {
    list.mockResolvedValue(err('models directory is gone'))

    await useModelStore.getState().refresh()

    expect(notifyError).toHaveBeenCalledWith('Could not load models', 'models directory is gone')
  })
})
