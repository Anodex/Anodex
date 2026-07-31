import { GOOGLE_MODELS, DEFAULT_GOOGLE_MODEL } from '@shared/googleModels'
import { XAI_MODELS, DEFAULT_XAI_MODEL } from '@shared/xaiModels'
import { DEEPSEEK_MODELS, DEFAULT_DEEPSEEK_MODEL } from '@shared/deepseekModels'
import { MISTRAL_MODELS, DEFAULT_MISTRAL_MODEL } from '@shared/mistralModels'
import { GROQ_MODELS, DEFAULT_GROQ_MODEL } from '@shared/groqModels'
import { OPENROUTER_MODELS, DEFAULT_OPENROUTER_MODEL } from '@shared/openrouterModels'
import { KIMI_MODELS, DEFAULT_KIMI_MODEL } from '@shared/kimiModels'
import { QWEN_MODELS, DEFAULT_QWEN_MODEL } from '@shared/qwenModels'
import type { CloudModelOption } from '@shared/cloudModelOption'
import type { LlmProvider } from './LlmProvider'
import {
  OpenAiCompatibleProvider,
  type OpenAiCompatibleConfig,
  type OpenAiCompatibleProviderId
} from './OpenAiCompatibleProvider'

/**
 * Static config for every OpenAI-Chat-Completions-compatible provider,
 * keyed by id — the single source of truth `ProviderRegistry.ts` uses to
 * instantiate each one, so a base URL/default model only ever needs to be
 * declared once. Kept separate from `OpenAiCompatibleProvider.ts` itself so
 * that file stays purely about *how* the generic adapter works, not *which*
 * providers exist — same class/registration split `AnthropicProvider.ts` vs
 * `ProviderRegistry.ts` already uses elsewhere in this codebase.
 */
export const OPEN_AI_COMPATIBLE_CONFIGS: Record<
  OpenAiCompatibleProviderId,
  OpenAiCompatibleConfig
> = {
  google: {
    id: 'google',
    displayName: 'Google AI',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: DEFAULT_GOOGLE_MODEL
  },
  xai: {
    id: 'xai',
    displayName: 'xAI',
    baseURL: 'https://api.x.ai/v1',
    defaultModel: DEFAULT_XAI_MODEL
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    // No `/v1` segment — confirmed via direct fetch of DeepSeek's own docs
    // 2026-07-24 that the real endpoint is `api.deepseek.com/chat/completions`.
    baseURL: 'https://api.deepseek.com',
    defaultModel: DEFAULT_DEEPSEEK_MODEL
  },
  mistral: {
    id: 'mistral',
    displayName: 'Mistral AI',
    baseURL: 'https://api.mistral.ai/v1',
    defaultModel: DEFAULT_MISTRAL_MODEL
  },
  groq: {
    id: 'groq',
    displayName: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: DEFAULT_GROQ_MODEL
  },
  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: DEFAULT_OPENROUTER_MODEL
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi',
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: DEFAULT_KIMI_MODEL
  },
  qwen: {
    id: 'qwen',
    displayName: 'Qwen',
    // International endpoint (most Anodex users are outside mainland
    // China); the mainland endpoint is the same path on
    // `dashscope.aliyuncs.com` (no `-intl`) if that's ever needed instead.
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaultModel: DEFAULT_QWEN_MODEL
  }
}

/**
 * Each provider's curated model catalog, keyed the same way as
 * `OPEN_AI_COMPATIBLE_CONFIGS` — `ProviderConnectionsPanel.tsx` builds every
 * simple cloud provider's model dropdown from this single map instead of a
 * hardcoded per-provider switch, so a new model showing up in one of the
 * `shared/*Models.ts` catalogs never needs a UI change to appear.
 */
export const MODEL_CATALOGS_BY_PROVIDER: Record<OpenAiCompatibleProviderId, CloudModelOption[]> = {
  google: GOOGLE_MODELS,
  xai: XAI_MODELS,
  deepseek: DEEPSEEK_MODELS,
  mistral: MISTRAL_MODELS,
  groq: GROQ_MODELS,
  openrouter: OPENROUTER_MODELS,
  kimi: KIMI_MODELS,
  qwen: QWEN_MODELS
}

export const openAiCompatibleProviders: Record<OpenAiCompatibleProviderId, LlmProvider> = {
  google: new OpenAiCompatibleProvider(OPEN_AI_COMPATIBLE_CONFIGS.google),
  xai: new OpenAiCompatibleProvider(OPEN_AI_COMPATIBLE_CONFIGS.xai),
  deepseek: new OpenAiCompatibleProvider(OPEN_AI_COMPATIBLE_CONFIGS.deepseek),
  mistral: new OpenAiCompatibleProvider(OPEN_AI_COMPATIBLE_CONFIGS.mistral),
  groq: new OpenAiCompatibleProvider(OPEN_AI_COMPATIBLE_CONFIGS.groq),
  openrouter: new OpenAiCompatibleProvider(OPEN_AI_COMPATIBLE_CONFIGS.openrouter),
  kimi: new OpenAiCompatibleProvider(OPEN_AI_COMPATIBLE_CONFIGS.kimi),
  qwen: new OpenAiCompatibleProvider(OPEN_AI_COMPATIBLE_CONFIGS.qwen)
}

/** Type guard for the providers this generic adapter covers. */
export function isOpenAiCompatibleProviderId(id: string): id is OpenAiCompatibleProviderId {
  return id in OPEN_AI_COMPATIBLE_CONFIGS
}
