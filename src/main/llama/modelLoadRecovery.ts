/**
 * Turns a crashed model load into a concrete, safer next attempt.
 *
 * Pure on purpose — the sentinel's file handling lives in `loadSentinel.ts`,
 * so the actual decision ("what changes on the retry, and what do we tell the
 * user it means") is unit-testable without an Electron app or a real crash.
 *
 * The ladder is deliberate. GPU offload is this project's documented
 * hardware-specific failure mode, so it is always the first thing dropped. If
 * a load crashed with offload *already* off, the driver is exonerated and the
 * next suspect is size, so the retry halves the context instead. A load that
 * crashed CPU-only at a floor context has no lever left to pull, and saying so
 * is more useful than offering an identical retry dressed up as a fix.
 */

import type { InterruptedModelLoad, ModelLoadRecovery } from '@shared/model.types'

/**
 * Smallest context a retry will propose. Below this a model is too cramped to
 * hold a system prompt plus tool schemas and still be worth loading, so
 * shrinking further trades one failure for a less obvious one.
 */
export const MIN_RECOVERY_CONTEXT = 2048

/** Halve `size` toward {@link MIN_RECOVERY_CONTEXT}, or `null` if already there. */
export function reducedContext(size: number | undefined): number | null {
  if (size === undefined) return null
  const halved = Math.floor(size / 2)
  if (halved < MIN_RECOVERY_CONTEXT) return null
  return halved
}

function describeSettings(interrupted: InterruptedModelLoad): string {
  const offload = interrupted.gpuLayers === 'auto' ? 'automatic' : `${interrupted.gpuLayers} layers`
  const context = interrupted.contextSize
    ? `, ${interrupted.contextSize.toLocaleString()} context`
    : ''
  return `GPU offload ${offload}${context}`
}

/**
 * Describe an interrupted load and the safest retry available for it.
 *
 * Always returns a recovery — there is no case where the right answer is
 * silence, because the alternative is auto-restoring the same crash.
 */
export function recoveryFor(interrupted: InterruptedModelLoad): ModelLoadRecovery {
  const alreadyCpuOnly = interrupted.gpuLayers === 0
  const headline = `Anodex closed while loading ${interrupted.modelName}`

  if (!alreadyCpuOnly) {
    return {
      interrupted,
      retry: { gpuLayers: 0, contextSize: interrupted.contextSize },
      headline,
      explanation:
        `The last launch started this model with ${describeSettings(interrupted)} and stopped before it finished — ` +
        'the pattern of a graphics driver failing inside the inference engine, which takes the whole app down with it. ' +
        'Loading on the CPU alone is slower but avoids the GPU entirely.',
      retryLabel: 'Retry on CPU only',
      alreadyCpuOnly
    }
  }

  const smaller = reducedContext(interrupted.contextSize)
  if (smaller !== null) {
    return {
      interrupted,
      retry: { gpuLayers: 0, contextSize: smaller },
      headline,
      explanation:
        `This model was already loading on the CPU alone, so the graphics driver isn't the cause. ` +
        `The next most likely one is size — a ${interrupted.contextSize?.toLocaleString()} token context has to be ` +
        `allocated up front. Retrying at ${smaller.toLocaleString()} asks for roughly half as much memory.`,
      retryLabel: `Retry at ${smaller.toLocaleString()} context`,
      alreadyCpuOnly
    }
  }

  return {
    interrupted,
    retry: { gpuLayers: 0, contextSize: interrupted.contextSize },
    headline,
    explanation:
      'This model was already loading on the CPU alone at a small context, so neither the graphics driver nor the ' +
      'context size explains it. The model file itself may be truncated or corrupt — a re-download, or a smaller ' +
      'quantization of the same model, is the next thing to try.',
    retryLabel: 'Try loading it again',
    alreadyCpuOnly
  }
}
