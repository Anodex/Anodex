import type { AppSettings } from './settings.types'
import { DEFAULT_ANTHROPIC_MODEL } from './anthropicModels'
import { DEFAULT_OPENAI_MODEL } from './openaiModels'

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
    lastModelPath: undefined,
    generation: {
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 2048
    },
    model: {
      contextSize: 8192,
      gpuLayers: 'auto'
    },
    ui: {
      theme: 'dark'
    },
    assistantStyle: {
      globalStyle: ''
    },
    profile: {
      displayName: 'Anodex User',
      email: '',
      avatarBase64: null,
      planTier: 'free',
      accountStatus: 'active',
      syncStatus: 'local'
    },
    appearance: {
      themeMode: 'dark',
      presetTheme: 'midnight',
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
      reducedMotion: false,
      compactMode: false,
      diffView: 'unified'
    },
    general: {
      projectFolder: null,
      defaultWorkspace: null,
      startupBehavior: 'reopen',
      permissionMode: 'ask',
      desktopNotifications: false,
      autoSave: true,
      confirmDestructive: true,
      defaultShell: 'powershell'
    },
    workspace: {
      root: null
    },
    tools: {
      enabled: true
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
      personalEnabled: true
    },
    transcriptRecall: {
      enabled: true,
      crossScopeEnabled: false,
      archivedEnabled: false,
      cloudProviderEnabled: true
    },
    scheduler: {
      keepAwake: false
    },
    email: {
      provider: 'none',
      gmail: {
        enabled: false,
        address: '',
        oauthClientId: '',
        oauthClientSecret: '',
        syncMode: 'metadata',
        sendRequiresApproval: true
      }
    }
  }
}
