import { llamaService } from '../llama/LlamaService'

/**
 * Where to run the speech, and how many at once.
 *
 * Not a constant, because the right answer depends on what else is on the card.
 * Arc shares a GPU with whatever model the chat is using, and when that model is
 * resident the TTS model does not merely go slower — GPU offload becomes worse
 * than not offloading at all. Measured on one reply, twelve sentences, same
 * machine and same moment, with a 20.6 GB chat model loaded on a 24 GB card:
 *
 * | GPU, two at a time (what shipped) | 152 s |
 * | CPU, one at a time                | 126 s |
 * | CPU, two at a time                | 113 s |
 * | CPU, four at a time               |  96 s |
 *
 * And the same sentence took 0.98 s to generate with the card free against
 * 5.22 s with it busy — the contention costs more than five times what the work
 * does. So the rule is: if something is already using the GPU, do not queue
 * behind it. The CPU is idle in that situation and four processes fit on it
 * comfortably.
 *
 * With the card free, the GPU is much the better choice and two at a time is the
 * measured optimum — three and four thrash, because each process loads its own
 * 2.3 GB copy (169 s and 102 s against 36 s at two).
 */
export interface SpeechLoad {
  /** `-ngl`: 99 to offload everything, 0 to stay on the CPU. */
  gpuLayers: number
  /** How many sentences to generate at once. */
  concurrency: number
  /** Said in the log, so a slow reading can be explained without guessing. */
  reason: string
}

export const ON_A_FREE_GPU: SpeechLoad = {
  gpuLayers: 99,
  concurrency: 2,
  reason: 'gpu free'
}

export const BESIDE_A_CHAT_MODEL: SpeechLoad = {
  gpuLayers: 0,
  concurrency: 4,
  reason: 'gpu busy with the chat model'
}

/**
 * Whether the chat's own model is occupying the GPU right now.
 *
 * Anodex's model is the only thing Anodex can know about, and on the machine
 * this was measured on it is also the thing that was there. A card busy with
 * somebody else's program is not detected, and that is honest rather than
 * ignored: the cost of guessing wrong in that direction is the speed we already
 * ship, while guessing wrong the other way would move Arc off an idle GPU for no
 * reason.
 *
 * `gpuLayersUsed` rather than merely "a model is loaded": a chat model running
 * entirely on the CPU leaves the card free, and Arc should take it.
 */
function chatModelHoldsTheGpu(): boolean {
  try {
    const state = llamaService.getState()
    return state.status === 'ready' && (state.gpuLayersUsed ?? 0) > 0
  } catch {
    // Asked before the engine exists. Nothing is on the card that we know of.
    return false
  }
}

export function planSpeechLoad(): SpeechLoad {
  return chatModelHoldsTheGpu() ? BESIDE_A_CHAT_MODEL : ON_A_FREE_GPU
}
