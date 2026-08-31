import type { AppSettings } from '@shared/settings.types'
import type { AgentRunProviderId } from '@shared/agentRunProviders'
import { resolveModelContextSize } from '@shared/modelContextSize'
import type { RunProvenance } from '@shared/agentRun.types'

/**
 * What actually produced a run, recorded so its result can be compared later.
 *
 * Every one of 43 stored runs recorded `model: null`, because for a local run
 * the model is "whatever is loaded" and `AgentRun.model` exists to route a
 * cloud request rather than to describe anything. Six models were compared in a
 * single day and the record cannot say which run used which — so every
 * before/after number drawn from those runs was confounded by model mix, and
 * always would have been.
 *
 * The context window is here for the same reason. A turn holds roughly one
 * window of work, so a run at 8,192 and a run at 65,536 are not comparable
 * measurements of the same thing, and `maxTurnsCeilingFor` now scales with it.
 *
 * Purely descriptive. It is never read to decide anything at runtime — that is
 * deliberate, because `AgentRun.model` is passed to the provider as an
 * override, and a field that both describes and routes would eventually do one
 * of them wrong.
 */
export function describeRunProvenance(
  provider: AgentRunProviderId,
  settings: Pick<AppSettings, 'model' | 'modelContextSizes' | 'lastModelPath'>
): RunProvenance | null {
  // A cloud run already records its model in `model`, and its window is the
  // provider's to decide.
  if (provider !== 'local') return null
  const modelPath = settings?.lastModelPath
  if (!modelPath) return null
  return {
    model: modelName(modelPath),
    contextSize: resolveModelContextSize(settings, modelPath) ?? null
  }
}

/** `C:\models\Qwen3-27B.gguf` to `Qwen3-27B`, so runs group by model rather than by path. */
function modelName(modelPath: string): string {
  const cut = Math.max(modelPath.lastIndexOf('/'), modelPath.lastIndexOf('\\'))
  const base = cut === -1 ? modelPath : modelPath.slice(cut + 1)
  return base.replace(/\.[A-Za-z0-9]+$/, '')
}
