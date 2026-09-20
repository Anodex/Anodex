import type { RecommendedModel } from '../../recommendedModels'

/**
 * A catalog for the scorer to score.
 *
 * These twelve entries were Anodex's built-in catalog until it was deleted:
 * a list of models to download is no use to a machine that cannot reach the
 * network to download them, and nobody could refresh it without shipping a
 * new build, so it aged into a worse answer than none. See
 * `shared/recommendedModels.ts` for the whole story.
 *
 * The tests that used it are still testing the right things — slot
 * selection, family diversity, dedup, reliability blending — and all of them
 * need *some* catalog to work on. So the data moved here, where it is what
 * it always really was: a fixture. It is deliberately frozen; it does not
 * need to stay current, because nothing ships it.
 */
export const CATALOG_FIXTURE: RecommendedModel[] = [
  {
    id: 'llama-3.2-1b-q4',
    name: 'Llama 3.2 1B Instruct',
    publishedAt: '2024-09-25',
    family: 'meta',
    tier: '1b',
    description: 'Minimal footprint chat model for low-memory or older machines.',
    approxSize: '0.8 GB',
    minRam: '4 GB',
    minRamGb: 4,
    idealRamGb: 7,
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
    publishedAt: '2024-11-09',
    family: 'qwen',
    tier: '3b',
    description: 'Fast, capable coding assistant that runs comfortably on modest hardware.',
    approxSize: '2.0 GB',
    minRam: '6 GB',
    minRamGb: 6,
    idealRamGb: 8,
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
    publishedAt: '2024-09-25',
    family: 'meta',
    tier: '3b',
    description: 'Well-rounded general chat model with strong instruction following.',
    approxSize: '2.0 GB',
    minRam: '6 GB',
    minRamGb: 6,
    idealRamGb: 8,
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
    id: 'qwen3-8b-q4',
    name: 'Qwen3 8B',
    publishedAt: '2025-05-03',
    family: 'qwen',
    tier: '7b',
    description:
      'A modern all-rounder for coding, reasoning, and tool-driven work, with optional thinking mode.',
    approxSize: '4.7 GB',
    minRam: '9 GB',
    minRamGb: 9,
    idealRamGb: 12,
    downloadUrl: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
    tags: ['coding', 'tools', 'thinking'],
    primaryUse: 'agentic-coding',
    qualityRank: 5,
    speedRank: 4,
    supportsTools: true,
    supportsThinking: true,
    nativeContextTokens: 32768,
    stable: true,
    recommended: true
  },
  {
    id: 'mistral-7b-instruct-v0.3-q4',
    name: 'Mistral 7B Instruct v0.3',
    publishedAt: '2024-05-22',
    family: 'mistral',
    tier: '7b',
    description: 'Well-rounded general model with strong instruction following and long context.',
    approxSize: '4.4 GB',
    minRam: '9 GB',
    minRamGb: 9,
    idealRamGb: 12,
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
    id: 'gemma-3-4b-it-q4',
    name: 'Gemma 3 4B IT',
    publishedAt: '2025-03-12',
    family: 'google',
    tier: '3b',
    description:
      'A compact multimodal generalist for image understanding and long-document chat on modest hardware.',
    approxSize: '3.2 GB',
    minRam: '7 GB',
    minRamGb: 7,
    idealRamGb: 10,
    downloadUrl:
      'https://huggingface.co/ggml-org/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf',
    visionProjectorUrl:
      'https://huggingface.co/ggml-org/gemma-3-4b-it-GGUF/resolve/main/mmproj-model-f16.gguf',
    visionProjectorFileName: 'gemma-3-4b-it-mmproj-model-f16.gguf',
    tags: ['vision', 'long context', 'general'],
    primaryUse: 'general',
    qualityRank: 4,
    speedRank: 5,
    supportsTools: false,
    supportsThinking: false,
    nativeContextTokens: 131072,
    stable: true,
    recommended: true
  },
  {
    id: 'phi-4-q4-k-s',
    name: 'Phi-4',
    publishedAt: '2025-01-08',
    family: 'microsoft',
    tier: '14b',
    description:
      'A Microsoft general-reasoning model for math, code, and detailed instruction following.',
    approxSize: '8.4 GB',
    minRam: '14 GB',
    minRamGb: 14,
    idealRamGb: 17,
    downloadUrl: 'https://huggingface.co/microsoft/phi-4-gguf/resolve/main/phi-4-Q4_K_S.gguf',
    tags: ['reasoning', 'general', 'code'],
    primaryUse: 'general',
    qualityRank: 7,
    speedRank: 3,
    supportsTools: false,
    supportsThinking: false,
    nativeContextTokens: 16384,
    stable: true,
    recommended: true
  },
  {
    id: 'qwen2.5-coder-14b-q4',
    name: 'Qwen2.5 Coder 14B',
    publishedAt: '2024-11-09',
    family: 'qwen',
    tier: '14b',
    description: 'The most reliable local coding model for high-memory machines.',
    approxSize: '9.0 GB',
    minRam: '14 GB',
    minRamGb: 14,
    idealRamGb: 18,
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
    publishedAt: '2024-06-17',
    family: 'deepseek',
    tier: '14b',
    description:
      'Mixture-of-experts coding model — only ~2.4B active params per token, so it runs faster than its size suggests.',
    approxSize: '10.4 GB',
    minRam: '16 GB',
    minRamGb: 16,
    idealRamGb: 20,
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
    publishedAt: '2024-05-29',
    family: 'mistral',
    tier: '14b',
    description: "Mistral's dedicated code model — strong quality, heavier than the 14B class.",
    approxSize: '13.3 GB',
    minRam: '19 GB',
    minRamGb: 19,
    idealRamGb: 24,
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
    publishedAt: '2024-11-09',
    family: 'qwen',
    tier: '32b',
    description: 'Near top-tier local coding quality for high-memory workstations.',
    approxSize: '19.8 GB',
    minRam: '27 GB',
    minRamGb: 27,
    idealRamGb: 33,
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
    publishedAt: '2024-12-06',
    family: 'meta',
    tier: '70b',
    description:
      'The largest recommended general-chat model, for high-end multi-GPU or huge-RAM machines.',
    approxSize: '42.5 GB',
    minRam: '54 GB',
    minRamGb: 54,
    idealRamGb: 65,
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
