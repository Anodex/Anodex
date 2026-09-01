import type { ModelInfo, ModelLoadOptions, ModelStatus } from '@shared/model.types'

/**
 * Make sure a local model is actually on its way, rather than waiting for one.
 *
 * The unattended harnesses (`agentAutorun`, `criticalThinkingAutorun`) waited
 * for `llamaService.getState().status` to reach `ready`. Nothing in the main
 * process asks for a model: the renderer restores the last one a few seconds
 * after it paints, and the harnesses were relying on that happening. When it
 * did not, the wait could not end, because nothing was ever going to load
 * anything.
 *
 * Measured on a four-question sweep: two of the four runs never started. Their
 * logs show the autorun arming and then no model-load line at all, against a
 * working run where loading began eight seconds after arming. Two measurements
 * lost and about 24 minutes spent waiting for a model nobody had asked for.
 *
 * Deliberately does not wait for the load to finish — the caller already has a
 * timeout for that, and its own idea of how long is reasonable. This only
 * guarantees that something is loading.
 */
export type EnsureLocalModelResult =
  | 'ready'
  | 'already-loading'
  | 'loading-started'
  | 'no-model-configured'
  | 'model-file-missing'
  | 'load-failed'

export interface EnsureLocalModelDeps {
  /** The engine's current status. */
  status: ModelStatus
  /** The model the user last loaded, from settings. */
  lastModelPath: string | null | undefined
  /** Resolves a path to a model descriptor, or null when the file is gone. */
  describeModel: (path: string) => ModelInfo | null
  /** The same call the model IPC handler makes. */
  loadModel: (options: ModelLoadOptions, info: ModelInfo) => Promise<unknown>
  /** Context window to request; omitted lets the engine use the model default. */
  contextSize?: number
}

export async function ensureLocalModelLoaded(
  deps: EnsureLocalModelDeps
): Promise<EnsureLocalModelResult> {
  if (deps.status === 'ready') return 'ready'
  // The renderer may already be loading the same model. Starting a second load
  // would allocate another copy of a multi-gigabyte model beside it.
  if (deps.status === 'loading') return 'already-loading'

  const path = deps.lastModelPath?.trim()
  if (!path) return 'no-model-configured'

  const info = deps.describeModel(path)
  // A remembered path can outlive the file it names — a model deleted or a
  // drive not mounted yet.
  if (!info) return 'model-file-missing'

  try {
    await deps.loadModel(
      {
        path,
        // Carried through for the same reason the IPC handler carries it: a
        // vision model loaded without its projector silently loses vision.
        visionProjectorPath: info.visionProjectorPath,
        contextSize: deps.contextSize
      },
      info
    )
    return 'loading-started'
  } catch {
    // Returned rather than thrown: the harness's own message names the run and
    // the question, which is what the reader can act on. A stack trace here
    // would replace that with an unattributed failure.
    return 'load-failed'
  }
}
