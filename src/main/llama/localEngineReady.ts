import { llamaService } from './LlamaService'
import { ensureLocalModelLoaded } from './ensureLocalModelLoaded'
import { describeModel } from './modelScanner'
import { resolveModelContextSize } from '@shared/modelContextSize'
import { settingsStore } from '../settings/SettingsStore'
import { createLogger } from '../utils/logger'

const log = createLogger('local-engine-ready')

/** Long enough for a cold multi-gigabyte load, short enough to give up on. */
export const DEFAULT_MODEL_READY_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Whether anything in a run will need the local engine.
 *
 * Not just the run's own provider. A cloud parent delegating to local
 * sub-agents is a real configuration — the parent holds no local slot, so the
 * children get every one of them — and looking only at the parent lets its
 * first local child fail in zero seconds with "No model is loaded".
 */
export function needsLocalEngine(
  provider: string,
  childProviders: readonly string[] = []
): boolean {
  return provider === 'local' || childProviders.includes('local')
}

/**
 * Make the local engine ready before starting unattended work, or say why not.
 *
 * Nothing in the main process asks for a model — the renderer restores the
 * last one a few seconds after it paints — so waiting for `ready` can wait
 * forever when that has not happened. This asks, and then waits.
 *
 * Extracted from `agentAutorun`, which had it right, once a scheduled
 * continuation got it wrong. Measured: a continuation fired on the scheduler's
 * first tick about five seconds after launch, while the model was still
 * loading, and the run it started died immediately — burning the occurrence
 * and, on a daily schedule, the day. Every unattended entry point needs this,
 * which is the argument for it living in one place rather than in the one that
 * happened to be written first.
 *
 * Returns null when the engine is ready, or a sentence saying what stopped it.
 * Never throws: the callers are all unattended, and an exception there becomes
 * a run that failed for a reason nobody recorded.
 */
export async function localEngineReady(
  provider: string,
  options: { childProviders?: readonly string[]; timeoutMs?: number } = {}
): Promise<string | null> {
  if (!needsLocalEngine(provider, options.childProviders ?? [])) return null
  if (llamaService.getState().status === 'ready') return null

  const settings = settingsStore.get()
  const loaded = await ensureLocalModelLoaded({
    status: llamaService.getState().status,
    lastModelPath: settings.lastModelPath,
    describeModel,
    loadModel: (loadOptions, info) => llamaService.loadModel(loadOptions, info),
    parallelJobs: settings.model?.parallelJobs,
    contextSize: resolveModelContextSize(settings, settings.lastModelPath ?? null)
  })
  if (loaded === 'no-model-configured') return 'No local model is configured to load.'
  if (loaded === 'model-file-missing') return 'The last local model file could not be found.'
  if (loaded === 'load-failed') return 'The local model could not be loaded.'
  log.info('Local engine:', loaded)

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_MODEL_READY_TIMEOUT_MS)
  while (Date.now() < deadline) {
    if (llamaService.getState().status === 'ready') return null
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return 'The local model was still loading, so this was left for the next time.'
}
