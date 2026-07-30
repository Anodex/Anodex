/** Types describing local models and the state of the Llama engine. */

/** Lifecycle of the currently selected model in the Llama engine. */
export type ModelStatus = 'unloaded' | 'loading' | 'ready' | 'error'

/**
 * A model file discovered on disk. `source` is future-proofed so that
 * downloaded or remote-provider models can join the same list later.
 */
export interface ModelInfo {
  /** Stable id derived from the absolute file path. */
  id: string
  /** Display name (filename without extension, prettified). */
  name: string
  /** Absolute path to the `.gguf` file. */
  path: string
  /** File size in bytes. */
  sizeBytes: number
  /** Quantization label parsed from the filename, e.g. `Q4_K_M`. */
  quant?: string
  /**
   * Matching llama.cpp multimodal projector. Present when Anodex found a
   * companion `mmproj` file or the user explicitly associated one.
   */
  visionProjectorPath?: string
  /** Projector size, included in compatibility/memory messaging. */
  visionProjectorSizeBytes?: number
  /** Where the model came from. Only `local` is supported today. */
  source: 'local'
}

/** Options passed when loading a model into the engine. */
export interface ModelLoadOptions {
  path: string
  /** Load through Anodex's bundled llama.cpp multimodal runtime when present. */
  visionProjectorPath?: string
  /** Context window size in tokens. Falls back to the model default when omitted. */
  contextSize?: number
  /** Number of layers to offload to GPU. `'auto'` lets the engine decide. */
  gpuLayers?: number | 'auto'
}

/** Snapshot of the engine's current model state, broadcast to the renderer. */
export interface EngineState {
  status: ModelStatus
  /** The model currently loaded (or being loaded). */
  model?: ModelInfo
  /** Present when `status === 'error'`. */
  error?: string
  /** Effective context size once the model is ready. */
  contextSize?: number
  /** True when the active local backend accepts image inputs. */
  vision?: boolean
  /**
   * Actual number of layers offloaded to the GPU for the loaded model — the
   * real number the engine resolved, whether `gpuLayers` was `'auto'` or a
   * specific count. `0` if GPU offload is disabled or unavailable.
   */
  gpuLayersUsed?: number
  /** Total layer count of the loaded model, read from its GGUF metadata. */
  gpuLayersTotal?: number
  /**
   * Actual tokens currently held in the active session's context (KV cache),
   * read straight from the engine — includes the system prompt, tool
   * schemas, replayed history, and everything generated so far. Only
   * meaningful for whichever conversation `contextTokensConversationId`
   * names; a text-length estimate is used everywhere else (e.g. a
   * conversation switched to but not yet generated in this session).
   */
  contextTokensUsed?: number
  /** Conversation id `contextTokensUsed` was measured for. */
  contextTokensConversationId?: string
  /** True while a completion is actively being generated. */
  generating: boolean
}

/**
 * Hardware-and-file-aware recommendation for a *specific* `.gguf` file —
 * unlike `ModelRecommendation` in `modelRecommendation.ts` (which picks a
 * model to *download* from the curated catalog based on hardware alone),
 * this reads the actual file's own GGUF metadata. Works identically for a
 * catalog download or a model the user added themselves, since it only
 * depends on having a real file to read.
 */
export interface ModelSettingsRecommendation {
  contextSize: number
  gpuLayers: 'auto'
  maxTokens: number
  /** The model's own trained context length, if the GGUF metadata reports one. */
  trainContextSize?: number
  /** Total layer count, read from the GGUF metadata. */
  totalLayers: number
  /** Human-readable explanation shown in the UI. */
  rationale: string
}

/**
 * A model load that started and never reported an outcome — recorded on disk
 * before the native engine is touched and cleared the moment it returns, so
 * finding one at startup means the previous run died mid-load.
 *
 * The failure this exists for is not catchable in JavaScript: a GPU-backend
 * crash inside llama.cpp takes the whole process down, leaving no error to
 * report and no state to read. Without this record the app auto-restores the
 * same model with the same settings on the next launch and crashes again, with
 * no way out that doesn't involve editing settings.json by hand.
 */
export interface InterruptedModelLoad {
  modelPath: string
  modelName: string
  /** The offload setting that was in effect, exactly as requested. */
  gpuLayers: number | 'auto'
  /** Requested context size, before any engine-side shrinking. */
  contextSize?: number
  /** True when the load went through the multimodal runtime. */
  vision: boolean
  /** ISO timestamp of when the load began. */
  startedAt: string
}

/** What to tell the user about an {@link InterruptedModelLoad}, and what to retry with. */
export interface ModelLoadRecovery {
  interrupted: InterruptedModelLoad
  /** Load options for the safer retry — never the ones that just crashed. */
  retry: { gpuLayers: number; contextSize?: number }
  headline: string
  explanation: string
  /** Action label for the safer retry, naming what actually changes. */
  retryLabel: string
  /**
   * True when GPU offload was already off, so the graphics driver isn't the
   * suspect and the retry has to reduce something else instead.
   */
  alreadyCpuOnly: boolean
}

/** Progress of an in-app recommended-model download, broadcast to the renderer. */
export interface ModelDownloadProgress {
  /** `RecommendedModel.id` of the model being downloaded. */
  modelId: string
  receivedBytes: number
  /** `null` when the server didn't report a `content-length`. */
  totalBytes: number | null
  status: 'downloading' | 'done' | 'error' | 'canceled'
  /** Present when `status === 'error'`. */
  error?: string
}
