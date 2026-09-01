import { describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '@shared/model.types'
import { ensureLocalModelLoaded } from '../ensureLocalModelLoaded'

/**
 * The unattended harnesses waited for `llamaService.getState().status` to reach
 * `ready`, and nothing in the main process ever asks for a model — the renderer
 * restores the last one a few seconds after it paints. When that did not
 * happen, the wait could not end.
 *
 * Measured on a four-question sweep: two runs never started. Their logs show
 * the autorun arming and then no model-load line at all, against a working run
 * where loading began eight seconds after arming. Two of four measurements
 * lost, and about 24 minutes of wall clock spent waiting for a model nothing
 * had asked for.
 */
const info: ModelInfo = {
  id: 'model-1',
  name: 'Test model',
  path: 'C:/models/test.gguf',
  sizeBytes: 1,
  source: 'local'
}

function deps(overrides: Partial<Parameters<typeof ensureLocalModelLoaded>[0]> = {}) {
  return {
    status: 'unloaded' as const,
    lastModelPath: 'C:/models/test.gguf',
    describeModel: () => info,
    loadModel: vi.fn(() => Promise.resolve()),
    ...overrides
  }
}

describe('ensureLocalModelLoaded', () => {
  it('loads the last model when nothing is loaded', async () => {
    const d = deps()
    expect(await ensureLocalModelLoaded(d)).toBe('loading-started')
    expect(d.loadModel).toHaveBeenCalledOnce()
  })

  it('passes the projector the scanner found', async () => {
    // A vision model loaded without its projector silently loses vision, which
    // is what the IPC handler is careful about too.
    const d = deps({
      describeModel: () => ({ ...info, visionProjectorPath: 'C:/models/mmproj.gguf' })
    })
    await ensureLocalModelLoaded(d)
    expect(d.loadModel).toHaveBeenCalledWith(
      expect.objectContaining({ visionProjectorPath: 'C:/models/mmproj.gguf' }),
      expect.objectContaining({ path: info.path })
    )
  })

  it('does nothing when a model is already loaded', async () => {
    const d = deps({ status: 'ready' })
    expect(await ensureLocalModelLoaded(d)).toBe('ready')
    expect(d.loadModel).not.toHaveBeenCalled()
  })

  it('does not race a load the renderer already started', async () => {
    // Both may run: the harness must not allocate a second copy of a 27B model
    // alongside the renderer's.
    const d = deps({ status: 'loading' })
    expect(await ensureLocalModelLoaded(d)).toBe('already-loading')
    expect(d.loadModel).not.toHaveBeenCalled()
  })

  it('reports when no model has ever been selected', async () => {
    const d = deps({ lastModelPath: null })
    expect(await ensureLocalModelLoaded(d)).toBe('no-model-configured')
    expect(d.loadModel).not.toHaveBeenCalled()
  })

  it('reports a path whose file has since gone', async () => {
    const d = deps({ describeModel: () => null })
    expect(await ensureLocalModelLoaded(d)).toBe('model-file-missing')
    expect(d.loadModel).not.toHaveBeenCalled()
  })

  it('reports a failed load rather than throwing into the harness', async () => {
    // A throw here would abort the run with a stack trace instead of the
    // harness's own diagnosis, which is what the caller can act on.
    const d = deps({ loadModel: vi.fn(() => Promise.reject(new Error('out of memory'))) })
    expect(await ensureLocalModelLoaded(d)).toBe('load-failed')
  })
})
