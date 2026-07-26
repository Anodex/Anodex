import type { AppSettings } from './settings.types'
import { DEFAULT_ANTHROPIC_MODEL } from './anthropicModels'
import { DEFAULT_OPENAI_MODEL } from './openaiModels'
import { DEFAULT_GOOGLE_MODEL } from './googleModels'
import { DEFAULT_XAI_MODEL } from './xaiModels'
import { DEFAULT_DEEPSEEK_MODEL } from './deepseekModels'
import { DEFAULT_MISTRAL_MODEL } from './mistralModels'
import { DEFAULT_GROQ_MODEL } from './groqModels'
import { DEFAULT_OPENROUTER_MODEL } from './openrouterModels'
import { DEFAULT_KIMI_MODEL } from './kimiModels'
import { DEFAULT_QWEN_MODEL } from './qwenModels'

/**
 * Default settings, parameterised by the platform-specific models directory
 * (resolved in the main process from Electron's `userData` path).
 *
 * These defaults favour reliable coding: a low temperature for precise tool use,
 * a generous token budget so multi-step turns don't truncate, and a context
 * window large enough to keep earlier steps in memory. The context size and
 * token budget are re-seeded from detected hardware on first run.
 *
 * `assistantStyle.globalStyle` is *additional* user guidance layered on top of
 * the built-in coding-agent prompt (see `src/shared/prompts.ts`), so it
 * defaults to empty rather than carrying the agent's behaviour.
 */
export function createDefaultSettings(modelsDirectory: string): AppSettings {
  return {
    modelsDirectory,
    addedModelPaths: [],
    visionProjectorPaths: {},
    lastModelPath: undefined,
    generation: {
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 2048,
      turnTimeLimitMinutes: 15
    },
    model: {
      contextSize: 8192,
      gpuLayers: 'auto'
    },
    ui: {},
    assistantStyle: {
      globalStyle: ''
    },
    profile: {
      displayName: 'Anodex User',
      avatarBase64: null,
      planTier: 'free',
      accountStatus: 'active',
      syncStatus: 'local'
    },
    appearance: {
      theme: 'midnight',
      customTheme: {
        primary: '#4f8cff',
        accent: '#7aa7ff',
        background: '#0b0d12',
        surface: '#12151d',
        surfaceHighlight: '#1a1e29',
        border: '#252a36',
        text: '#e8ebf0',
        textMuted: '#8b92a3'
      },
      font: 'system',
      fontSize: 'medium',
      density: 'comfortable',
      soundEffects: false,
      soundTheme: 'soft',
      soundVolume: 70,
      reducedMotion: false,
      compactMode: false,
      diffView: 'unified',
      chatBackground: 'deepField'
    },
    general: {
      permissionMode: 'ask',
      desktopNotifications: false,
      confirmDestructive: true,
      defaultShell: 'powershell'
    },
    workspace: {
      root: null
    },
    tools: {
      enabled: true,
      disabledTools: []
    },
    provider: {
      active: 'local',
      anthropic: {
        apiKey: '',
        model: DEFAULT_ANTHROPIC_MODEL,
        dailyTokenCap: null
      },
      openai: {
        apiKey: '',
        model: DEFAULT_OPENAI_MODEL,
        dailyTokenCap: null
      },
      google: {
        apiKey: '',
        model: DEFAULT_GOOGLE_MODEL,
        dailyTokenCap: null
      },
      xai: {
        apiKey: '',
        model: DEFAULT_XAI_MODEL,
        dailyTokenCap: null
      },
      deepseek: {
        apiKey: '',
        model: DEFAULT_DEEPSEEK_MODEL,
        dailyTokenCap: null
      },
      mistral: {
        apiKey: '',
        model: DEFAULT_MISTRAL_MODEL,
        dailyTokenCap: null
      },
      groq: {
        apiKey: '',
        model: DEFAULT_GROQ_MODEL,
        dailyTokenCap: null
      },
      openrouter: {
        apiKey: '',
        model: DEFAULT_OPENROUTER_MODEL,
        dailyTokenCap: null
      },
      azure: {
        apiKey: '',
        resourceName: '',
        deploymentName: '',
        apiVersion: '2024-10-21',
        dailyTokenCap: null
      },
      kimi: {
        apiKey: '',
        model: DEFAULT_KIMI_MODEL,
        dailyTokenCap: null
      },
      qwen: {
        apiKey: '',
        model: DEFAULT_QWEN_MODEL,
        dailyTokenCap: null
      }
    },
    webSearch: {
      provider: 'none',
      apiKey: '',
      searchEngineId: '',
      baseUrl: 'http://localhost:8080',
      resultCount: 5,
      requireApproval: false
    },
    diagnostics: {
      maxEntries: 250,
      clearOnRestart: true,
      verbose: false
    },
    memory: {
      crossChatEnabled: true,
      personalEnabled: true,
      confirmBeforeSaving: false
    },
    transcriptRecall: {
      enabled: true,
      crossScopeEnabled: false,
      archivedEnabled: false,
      cloudProviderEnabled: false
    },
    scheduler: {
      keepAwake: false
    },
    email: {
      accounts: [],
      primaryAccountId: null,
      sendRequiresApproval: true
    }
  }
}
