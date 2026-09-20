/**
 * The shape of a model Anodex can offer to download, and the helpers that read
 * it.
 *
 * This file used to also hold `RECOMMENDED_MODELS`, a hand-written list of
 * twelve. It is gone. Every model here has to be fetched over the network, so
 * a list kept for the offline case helped exactly nobody — and a list nobody
 * could update without shipping a new Anodex went stale immediately: on the
 * day it was removed, every entry was between twenty and twenty-eight months
 * old, and a user with no connection was being told the best model for their
 * machine was one from November 2024 that they also could not download.
 *
 * What replaced it: `huggingFaceCatalog` fetches the current list,
 * `topModelsCache` keeps the last one that arrived, and `modelRecommendation`
 * answers "what size suits this machine" from hardware alone, which never
 * needed a catalog in the first place.
 */

/**
 * Model size class, used to match a model to detected hardware. Spans from
 * low-end machines to high-end workstations, since this app is shared across
 * a wide range of user hardware — not just the machine it was built on.
 */
export type ModelTier = '1b' | '3b' | '7b' | '14b' | '32b' | '70b'

export type RecommendedModelUse = 'coding' | 'general' | 'agentic-coding'

/**
 * The lab/company behind a model, used to show its real logo instead of a
 * generic icon. Kept to families Anodex can show a real, verified logo for
 * (see `ModelLogo.tsx`) — `'other'` is the honest fallback for anything else,
 * rather than guessing or approximating a brand mark.
 */
export type ModelFamily =
  'meta' | 'qwen' | 'mistral' | 'google' | 'deepseek' | 'microsoft' | 'other'

export interface RecommendedModel {
  id: string
  name: string
  /** Lab/company behind the model, for logo display. */
  family: ModelFamily
  /** Size class used by the hardware recommender. */
  tier: ModelTier
  /** Short description of what the model is good for. */
  description: string
  /** Approximate on-disk size, e.g. `"2.0 GB"`. */
  approxSize: string
  /** Suggested minimum total system RAM, e.g. `"8 GB"`. */
  minRam: string
  /** Suggested minimum total system RAM in GB, for hardware matching. */
  minRamGb: number
  /** Recommended total system RAM in GB for a smoother experience. */
  idealRamGb?: number
  /** Recommended dedicated VRAM in GB when the model is too large for a good CPU-only default. */
  minVramGb?: number
  /** True when the model should not be a default pick on CPU-only hardware. */
  requiresGpuRecommended?: boolean
  /** Direct GGUF download URL (used by the upcoming downloader). */
  downloadUrl: string
  /** Matching llama.cpp multimodal projector, when the repository publishes one. */
  visionProjectorUrl?: string
  /** Filename used for the locally downloaded projector. */
  visionProjectorFileName?: string
  /** Broad capability tags for labelling. */
  tags: string[]
  /** Primary reason Anodex would recommend this model. */
  primaryUse?: RecommendedModelUse
  /** Higher means better answer quality within this curated catalog. */
  qualityRank?: number
  /** Higher means faster/lighter within this curated catalog. */
  speedRank?: number
  /** Whether the model is a good default for tool-calling/agentic code work. */
  supportsTools?: boolean
  /** Whether the model exposes useful reasoning/thinking traces locally. */
  supportsThinking?: boolean
  /** Native context limit published by the model provider, when verified. */
  nativeContextTokens?: number
  /** False for experimental models that should only appear behind advanced UI. */
  stable?: boolean
  /** False hides a catalog entry from the default recommendation path. */
  recommended?: boolean
  /**
   * `'catalog'` (the default, when omitted) is this file's own hand-vetted
   * list — every field above was chosen by a person. `'huggingface'` means it
   * was found live via `Models.discover` — its `qualityRank`/`speedRank`/
   * `primaryUse`/`supportsTools` are inferred from tags/name text, not
   * verified, and `minRamGb`/`idealRamGb` are estimated from file size rather
   * than measured. The UI should label these as unverified/community finds.
   */
  source?: 'catalog' | 'huggingface'
  /** Set when `source === 'huggingface'` — the repo this came from, e.g. `'bartowski/Llama-3.3-70B-Instruct-GGUF'`. */
  repoId?: string
  /**
   * When the model was published, ISO-8601, for live finds.
   *
   * What makes "is this current?" answerable at all. Downloads say how long a
   * model has existed as much as how good it is, so a recommendation built on
   * them alone drifts a generation behind and reads as confident while doing it.
   */
  publishedAt?: string
  /** Live popularity signals from Hugging Face, shown as a rough trust proxy since quality isn't hand-verified. */
  hfDownloads?: number
  hfLikes?: number
}

/**
 * The filename a model's GGUF is saved as, derived from its download URL.
 * Shared by the downloader (to pick the target path) and the renderer (to
 * detect a model that's already been downloaded), so they can never disagree.
 */
export function recommendedModelFileName(model: RecommendedModel): string {
  const path = new URL(model.downloadUrl).pathname
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name.toLowerCase().endsWith('.gguf') ? name : `${model.id}.gguf`
}

/** Stable local filename for a discovered model's companion vision projector. */
export function recommendedVisionProjectorFileName(model: RecommendedModel): string | null {
  if (!model.visionProjectorUrl) return null
  if (model.visionProjectorFileName) {
    const explicit = model.visionProjectorFileName.split(/[\\/]/).pop()
    if (
      explicit &&
      explicit !== '.' &&
      explicit !== '..' &&
      explicit.toLowerCase().endsWith('.gguf')
    ) {
      return explicit
    }
  }
  const modelName = recommendedModelFileName(model).replace(/\.gguf$/i, '')
  const path = new URL(model.visionProjectorUrl).pathname
  const projectorName = path.slice(path.lastIndexOf('/') + 1)
  return `${modelName}-${projectorName || 'mmproj.gguf'}`
}

/**
 * Best-effort family detection for an arbitrary installed GGUF, so its logo
 * can still show up correctly. Matched against the filename or model name, so
 * a manually downloaded Qwen or Llama variant gets its real logo without
 * anything having to recognise the specific release.
 */
export function inferModelFamily(name: string): ModelFamily {
  const n = name.toLowerCase()
  if (n.includes('qwen')) return 'qwen'
  if (n.includes('deepseek')) return 'deepseek'
  if (n.includes('phi')) return 'microsoft'
  if (n.includes('gemma')) return 'google'
  if (n.includes('mistral') || n.includes('mixtral') || n.includes('codestral')) return 'mistral'
  if (n.includes('llama')) return 'meta'
  return 'other'
}
