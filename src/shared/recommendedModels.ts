/**
 * A curated list of recommended local models, shared by the renderer (to guide
 * users on what to download) and the future in-app downloader in the main
 * process. It is deliberately data-only: a downloader can read `downloadUrl`,
 * write the file into the models directory, then trigger a re-scan.
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
export type ModelFamily = 'meta' | 'qwen' | 'mistral' | 'google' | 'deepseek' | 'other'

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
  /** Live popularity signals from Hugging Face, shown as a rough trust proxy since quality isn't hand-verified. */
  hfDownloads?: number
  hfLikes?: number
}

export const RECOMMENDED_MODELS: RecommendedModel[] = [
  {
    id: 'llama-3.2-1b-q4',
    name: 'Llama 3.2 1B Instruct',
    family: 'meta',
    tier: '1b',
    description: 'Minimal footprint chat model for low-memory or older machines.',
    approxSize: '0.8 GB',
    minRam: '4 GB',
    minRamGb: 4,
    idealRamGb: 6,
    downloadUrl:
      'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    tags: ['chat', 'lightweight'],
    primaryUse: 'general',
    qualityRank: 1,
    speedRank: 5,
    supportsTools: false,
    supportsThinking: false,
    stable: true,
    recommended: true
  },
  {
    id: 'qwen2.5-coder-3b-q4',
    name: 'Qwen2.5 Coder 3B',
    family: 'qwen',
    tier: '3b',
    description: 'Fast, capable coding assistant that runs comfortably on modest hardware.',
    approxSize: '2.0 GB',
    minRam: '8 GB',
    minRamGb: 8,
    idealRamGb: 12,
    downloadUrl:
      'https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf',
    tags: ['coding', 'fast'],
    primaryUse: 'coding',
    qualityRank: 3,
    speedRank: 5,
    supportsTools: true,
    supportsThinking: false,
    stable: true,
    recommended: true
  },
  {
    id: 'llama-3.2-3b-q4',
    name: 'Llama 3.2 3B Instruct',
    family: 'meta',
    tier: '3b',
    description: 'Well-rounded general chat model with strong instruction following.',
    approxSize: '2.0 GB',
    minRam: '8 GB',
    minRamGb: 8,
    idealRamGb: 12,
    downloadUrl:
      'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    tags: ['chat', 'general'],
    primaryUse: 'general',
    qualityRank: 2,
    speedRank: 5,
    supportsTools: false,
    supportsThinking: false,
    stable: true,
    recommended: true
  },
  {
    id: 'qwen2.5-coder-7b-q4',
    name: 'Qwen2.5 Coder 7B',
    family: 'qwen',
    tier: '7b',
    description: 'Higher-quality coding help for machines with more memory to spare.',
    approxSize: '4.7 GB',
    minRam: '16 GB',
    minRamGb: 16,
    idealRamGb: 24,
    downloadUrl:
      'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf',
    tags: ['coding', 'quality'],
    primaryUse: 'coding',
    qualityRank: 5,
    speedRank: 4,
    supportsTools: true,
    supportsThinking: false,
    stable: true,
    recommended: true
  },
  {
    id: 'mistral-7b-instruct-v0.3-q4',
    name: 'Mistral 7B Instruct v0.3',
    family: 'mistral',
    tier: '7b',
    description: 'Well-rounded general model with strong instruction following and long context.',
    approxSize: '4.4 GB',
    minRam: '16 GB',
    minRamGb: 16,
    idealRamGb: 24,
    downloadUrl:
      'https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
    tags: ['chat', 'general'],
    primaryUse: 'general',
    qualityRank: 4,
    speedRank: 4,
    supportsTools: false,
    supportsThinking: false,
    stable: true,
    recommended: true
  },
  {
    id: 'gemma-2-9b-it-q4',
    name: 'Gemma 2 9B Instruct',
    family: 'google',
    tier: '7b',
    description: "Google's well-regarded general model, a step up in quality from the 7B class.",
    approxSize: '5.8 GB',
    minRam: '20 GB',
    minRamGb: 20,
    idealRamGb: 30,
    downloadUrl:
      'https://huggingface.co/bartowski/gemma-2-9b-it-GGUF/resolve/main/gemma-2-9b-it-Q4_K_M.gguf',
    tags: ['chat', 'general'],
    primaryUse: 'general',
    qualityRank: 6,
    speedRank: 4,
    supportsTools: false,
    supportsThinking: false,
    stable: true,
    recommended: true
  },
  {
    id: 'qwen2.5-coder-14b-q4',
    name: 'Qwen2.5 Coder 14B',
    family: 'qwen',
    tier: '14b',
    description: 'The most reliable local coding model for high-memory machines.',
    approxSize: '9.0 GB',
    minRam: '32 GB',
    minRamGb: 32,
    idealRamGb: 48,
    downloadUrl:
      'https://huggingface.co/Qwen/Qwen2.5-Coder-14B-Instruct-GGUF/resolve/main/qwen2.5-coder-14b-instruct-q4_k_m.gguf',
    tags: ['coding', 'quality'],
    primaryUse: 'coding',
    qualityRank: 7,
    speedRank: 3,
    supportsTools: true,
    supportsThinking: false,
    stable: true,
    recommended: true
  },
  {
    id: 'deepseek-coder-v2-lite-instruct-q4',
    name: 'DeepSeek Coder V2 Lite',
    family: 'deepseek',
    tier: '14b',
    description:
      'Mixture-of-experts coding model — only ~2.4B active params per token, so it runs faster than its size suggests.',
    approxSize: '10.4 GB',
    minRam: '36 GB',
    minRamGb: 36,
    idealRamGb: 56,
    downloadUrl:
      'https://huggingface.co/bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF/resolve/main/DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf',
    tags: ['coding', 'quality'],
    primaryUse: 'coding',
    qualityRank: 8,
    speedRank: 4,
    supportsTools: false,
    supportsThinking: false,
    stable: true,
    recommended: true
  },
  {
    id: 'codestral-22b-v0.1-q4',
    name: 'Codestral 22B',
    family: 'mistral',
    tier: '14b',
    description: "Mistral's dedicated code model — strong quality, heavier than the 14B class.",
    approxSize: '13.3 GB',
    minRam: '40 GB',
    minRamGb: 40,
    idealRamGb: 60,
    minVramGb: 12,
    downloadUrl:
      'https://huggingface.co/bartowski/Codestral-22B-v0.1-GGUF/resolve/main/Codestral-22B-v0.1-Q4_K_M.gguf',
    tags: ['coding', 'quality'],
    primaryUse: 'coding',
    qualityRank: 8,
    speedRank: 2,
    supportsTools: false,
    supportsThinking: false,
    stable: true,
    recommended: true
  },
  {
    id: 'qwen2.5-coder-32b-q4',
    name: 'Qwen2.5 Coder 32B',
    family: 'qwen',
    tier: '32b',
    description: 'Near top-tier local coding quality for high-memory workstations.',
    approxSize: '19.8 GB',
    minRam: '48 GB',
    minRamGb: 48,
    idealRamGb: 64,
    minVramGb: 16,
    requiresGpuRecommended: false,
    downloadUrl:
      'https://huggingface.co/Qwen/Qwen2.5-Coder-32B-Instruct-GGUF/resolve/main/qwen2.5-coder-32b-instruct-q4_k_m.gguf',
    tags: ['coding', 'quality'],
    primaryUse: 'coding',
    qualityRank: 9,
    speedRank: 2,
    supportsTools: true,
    supportsThinking: false,
    stable: true,
    recommended: true
  },
  {
    id: 'llama-3.3-70b-q4',
    name: 'Llama 3.3 70B Instruct',
    family: 'meta',
    tier: '70b',
    description:
      'The largest recommended general-chat model, for high-end multi-GPU or huge-RAM machines.',
    approxSize: '42.5 GB',
    minRam: '96 GB',
    minRamGb: 96,
    idealRamGb: 128,
    minVramGb: 48,
    requiresGpuRecommended: true,
    downloadUrl:
      'https://huggingface.co/bartowski/Llama-3.3-70B-Instruct-GGUF/resolve/main/Llama-3.3-70B-Instruct-Q4_K_M.gguf',
    tags: ['chat', 'quality'],
    primaryUse: 'general',
    qualityRank: 10,
    speedRank: 1,
    supportsTools: false,
    supportsThinking: false,
    stable: true,
    recommended: true
  }
]

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

/**
 * Best-effort family detection for an arbitrary installed GGUF (a user-added
 * file, not necessarily one from `RECOMMENDED_MODELS`), so its logo can still
 * show up correctly. Matched against the filename/model name, not the catalog
 * — a manually downloaded Qwen or Llama variant should still get its real
 * logo even though it isn't one of the exact curated entries above.
 */
export function inferModelFamily(name: string): ModelFamily {
  const n = name.toLowerCase()
  if (n.includes('qwen')) return 'qwen'
  if (n.includes('deepseek')) return 'deepseek'
  if (n.includes('gemma')) return 'google'
  if (n.includes('mistral') || n.includes('mixtral') || n.includes('codestral')) return 'mistral'
  if (n.includes('llama')) return 'meta'
  return 'other'
}
