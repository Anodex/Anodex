/** Persisted application settings. */

import type { EmailAccount } from './email.types'

export interface GenerationSettings {
  temperature: number
  topP: number
  /** Maximum tokens to generate per reply. */
  maxTokens: number
  /**
   * Wall-clock cap on a single turn (covers all of its tool calls), in
   * minutes (1-120), for interactive chat and agent-run turns. `null`
   * disables the cap — a turn then runs until it finishes itself or hits its
   * tool-call / context-compaction limits instead. Scheduled tasks and
   * critical-thinking research keep their own fixed time budgets regardless
   * of this setting.
   */
  turnTimeLimitMinutes: number | null
}

export interface ModelSettings {
  /** Context window size in tokens. */
  contextSize: number
  /** GPU layer offload. `'auto'` lets the engine decide based on hardware. */
  gpuLayers: number | 'auto'
  /**
   * True once context/GPU/token defaults have been seeded from detected
   * hardware. Prevents overwriting the user's manual choices on later launches.
   */
  autoConfigured?: boolean
}

/**
 * No fields of its own today — kept only as the settings.json container
 * `migrateLegacyAssistantStyle` (in `SettingsStore.ts`) reads and strips a
 * legacy `systemPrompt` key from. Once that migration is retired, remove
 * this and the `ui` field on {@link Settings} together.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- see doc comment above
export interface UiSettings {}

/**
 * Hard cap on `AssistantStyleSettings.globalStyle` — durable voice/tone
 * guidance can hold a full custom personality, but should still stay well
 * below project instructions or pasted reference material. Exported so the
 * Settings UI can show a live counter against the same real limit that gets
 * enforced.
 */
export const MAX_ASSISTANT_STYLE_CHARS = 6000

export interface AssistantStyleSettings {
  /**
   * Durable voice/tone/personality guidance — how the assistant should
   * communicate, not what a specific project needs. Global only, never
   * loaded from a workspace file; injected right after Anodex's built-in
   * behavior, ahead of project instructions and any retrieved reference
   * data (workspace context, memory, past chats). Capped at
   * `MAX_ASSISTANT_STYLE_CHARS`.
   */
  globalStyle: string
}

export interface ProfileSettings {
  /** Display name shown in the UI header and settings. */
  displayName: string
  /** Contact email for sync / identification. */
  email: string
  /** Base64-encoded avatar image, or null if none is set. */
  avatarBase64: string | null
  /** Account tier shown for transparency. */
  planTier: 'free' | 'pro' | 'dev'
  /** Account lifecycle state. */
  accountStatus: 'active' | 'pending' | 'inactive'
  /** Data locality / sync state. */
  syncStatus: 'local' | 'syncing' | 'synced'
}

export type SoundTheme = 'soft' | 'crisp' | 'glass' | 'retro' | 'sciFi'

export interface AppearanceSettings {
  /**
   * The active theme. Each value is a complete, independent palette — there
   * is no separate light/dark "mode" layered on top; picking a different
   * theme from the list is the only thing that changes the look. 'system'
   * is the one special case: it watches the OS light/dark preference and
   * automatically switches between 'midnight' and 'midnightLight'.
   */
  theme: 'midnight' | 'midnightLight' | 'slate' | 'slateLight' | 'obsidian' | 'system' | 'custom'
  /** Custom CSS variables used when `theme` is 'custom'. */
  customTheme: {
    primary: string
    accent: string
    background: string
    surface: string
    surfaceHighlight: string
    border: string
    text: string
    textMuted: string
  }
  /** Preferred UI font family. */
  font: 'system' | 'mono' | 'sans'
  /** Global font size scale. */
  fontSize: 'small' | 'medium' | 'large'
  /** UI density. */
  density: 'compact' | 'comfortable'
  /** Play subtle interface feedback and task/approval/error chimes. */
  soundEffects: boolean
  /** Synthesized sound palette used for interface feedback and chimes. */
  soundTheme: SoundTheme
  /** Master sound level as a percentage from 0 to 100. */
  soundVolume: number
  /** Reduce animations and transitions. */
  reducedMotion: boolean
  /** Compact sidebar / header mode. */
  compactMode: boolean
  /** How file-edit diffs render in the chat transcript. */
  diffView: 'unified' | 'sideBySide'
  /** Animated scene behind an empty chat. */
  chatBackground: 'deepField' | 'siliconBloom'
}

/**
 * Master permission mode governing tool execution.
 * - ask: confirm every write/command, regardless of risk (default).
 * - full: safe mutations run automatically; sensitive/destructive actions are confirmed.
 * - untethered: safe/sensitive actions run automatically; destructive actions are still confirmed.
 */
export type PermissionMode = 'ask' | 'full' | 'untethered'

export interface GeneralSettings {
  /** Master permission mode; see {@link PermissionMode}. */
  permissionMode: PermissionMode
  /** Show desktop notifications for long-running tasks. */
  desktopNotifications: boolean
  /** Show a confirmation dialog before destructive actions. */
  confirmDestructive: boolean
  /** Default shell used by the run_command tool. */
  defaultShell: string
}

export interface WorkspaceSettings {
  /** Absolute path of the folder the AI's tools are scoped to, or null. */
  root: string | null
}

export interface ToolSettings {
  /** Master switch for the AI tool system. */
  enabled: boolean
  /**
   * Built-in tools excluded from normal interactive chats. Headless agent and
   * scheduled runs keep using their own explicit allowlists instead.
   */
  disabledTools: string[]
}

export interface AnthropicProviderSettings {
  /** User's Anthropic API key. Stored locally in settings, same as the web search provider keys. */
  apiKey: string
  /** Claude model id used for chat generations, e.g. `claude-sonnet-5`. */
  model: string
  /** Self-imposed daily token budget for this provider; `null` means no cap. Warn-only — never blocks a send. */
  dailyTokenCap: number | null
}

export interface OpenAiProviderSettings {
  /** User's OpenAI API key. Stored locally in settings, same as the web search provider keys. */
  apiKey: string
  /** OpenAI model id used for chat generations, e.g. `gpt-5.6` or `gpt-5.1-codex`. */
  model: string
  /** Self-imposed daily token budget for this provider; `null` means no cap. Warn-only — never blocks a send. */
  dailyTokenCap: number | null
}

/**
 * Shared shape for every "direct API key + model id" cloud provider that
 * speaks an OpenAI-compatible chat completions API — see
 * `OpenAiCompatibleProvider.ts`. Anthropic/OpenAI keep their own
 * identically-shaped types above rather than switching to this one, since
 * they predate it and nothing depends on them being structurally distinct;
 * only the newer providers reuse this directly.
 */
export interface CloudProviderSettings {
  /** User's API key for this provider. Stored locally in settings. */
  apiKey: string
  /** Model id used for chat generations, in this provider's own id format. */
  model: string
  /** Self-imposed daily token budget for this provider; `null` means no cap. Warn-only — never blocks a send. */
  dailyTokenCap: number | null
}

/**
 * Azure OpenAI has no fixed base URL or catalog of model ids — a customer
 * provisions their own resource and names their own deployments, so
 * `deploymentName` (a free-text field the user names themselves) stands in
 * for `CloudProviderSettings.model`, and `resourceName`/`apiVersion` locate
 * the actual endpoint. See `AzureOpenAiProvider.ts`.
 */
export interface AzureProviderSettings {
  /** Azure OpenAI resource API key. */
  apiKey: string
  /** The Azure resource name, e.g. `my-resource` for `my-resource.openai.azure.com`. */
  resourceName: string
  /** The deployment name the user created in Azure AI Studio for their chosen model. */
  deploymentName: string
  /** Azure OpenAI REST API version, e.g. `2024-10-21`. */
  apiVersion: string
  /** Self-imposed daily token budget for this provider; `null` means no cap. Warn-only — never blocks a send. */
  dailyTokenCap: number | null
}

export interface ProviderSettings {
  /** Which backend handles chat generation. `local` is the local Llama engine. */
  active:
    | 'local'
    | 'anthropic'
    | 'openai'
    | 'google'
    | 'xai'
    | 'deepseek'
    | 'mistral'
    | 'groq'
    | 'openrouter'
    | 'azure'
    | 'kimi'
    | 'qwen'
  anthropic: AnthropicProviderSettings
  openai: OpenAiProviderSettings
  google: CloudProviderSettings
  xai: CloudProviderSettings
  deepseek: CloudProviderSettings
  mistral: CloudProviderSettings
  groq: CloudProviderSettings
  openrouter: CloudProviderSettings
  azure: AzureProviderSettings
  kimi: CloudProviderSettings
  qwen: CloudProviderSettings
}

export interface WebSearchSettings {
  /** Search backend used by the web_search tool. */
  provider: 'none' | 'searxng' | 'brave' | 'tavily' | 'google'
  /** API key for providers that require one. */
  apiKey: string
  /** Google Custom Search Engine ID (used only by the Google provider). */
  searchEngineId: string
  /** Base URL of a self-hosted SearXNG instance. */
  baseUrl: string
  /** Maximum number of results to request per query. */
  resultCount: number
  /** When true, every web_search call asks for approval before hitting the API. */
  requireApproval: boolean
}

export interface DiagnosticEntry {
  id: string
  timestamp: number
  severity: 'error' | 'warning' | 'info'
  category: 'model' | 'provider' | 'file' | 'permission' | 'runtime' | 'general'
  message: string
  detail?: string
  suggestedFix?: string
}

export interface DiagnosticSettings {
  /** Number of recent diagnostic entries to keep in memory. */
  maxEntries: number
  /** Auto-clear info entries on app restart. */
  clearOnRestart: boolean
  /** Include verbose debug entries (not implemented yet). */
  verbose: boolean
}

export interface MemorySettings {
  /**
   * "Cross-chat memory" — recall/write project-scoped memories (conventions,
   * gotchas, open tasks) so they carry over between separate conversations in
   * the same project. Turning this off stops both retrieval and the
   * `remember_fact` tool for project scope; existing entries are kept, not deleted.
   */
  crossChatEnabled: boolean
  /**
   * "Personal memory" — recall/write global memories (user preferences) that
   * follow across every project. Turning this off stops retrieval of global
   * entries; existing entries are kept, not deleted.
   */
  personalEnabled: boolean
  /**
   * Always confirm a `remember_fact` call before it saves, even in
   * permission modes that would otherwise skip confirmation for a "safe"
   * risk tool. Off by default — immediate saving is the existing behavior;
   * this is an opt-in for anyone who wants to review every memory before
   * it's written, not a new default everyone has to deal with.
   */
  confirmBeforeSaving: boolean
}

export interface TranscriptRecallSettings {
  /** Master toggle for automatic cross-session transcript recall. */
  enabled: boolean
  /**
   * Search past chats outside the current scope too — every project and
   * every general chat — instead of just the active project's own history
   * (or general chats only, in a non-project chat). Off by default: recall
   * should stay scoped to what the current conversation is actually about
   * unless the user opts into a wider search.
   */
  crossScopeEnabled: boolean
  /** Include archived conversations in search. Off by default. */
  archivedEnabled: boolean
  /**
   * Allow retrieved excerpts to be sent to a cloud provider (OpenAI/
   * Anthropic), not just the local engine. A separate gate from `enabled`
   * since transcript excerpts are raw prior conversation content, a more
   * sensitive surface than curated structured memory.
   */
  cloudProviderEnabled: boolean
}

export interface SchedulerSettings {
  /** Prevent the system from sleeping so scheduled tasks keep firing while the app is open. */
  keepAwake: boolean
}

export interface EmailSettings {
  /**
   * Linked accounts, in the order they were added. Only the non-secret
   * descriptor lives here — tokens and IMAP/SMTP passwords are held by
   * `EmailAuthStore` under `safeStorage` encryption, keyed by account id.
   *
   * Mutated through the dedicated `email:*-account` IPC channels rather than
   * settings patches: `deepMerge` replaces arrays wholesale, so a patch-based
   * edit would make two concurrent writers clobber each other's accounts.
   */
  accounts: EmailAccount[]
  /** Account used when a request or tool call omits an explicit account id. */
  primaryAccountId: string | null
  /** Sending email is high-risk and is always confirmation-gated. */
  sendRequiresApproval: true
}

export interface AppSettings {
  /** Directory scanned for `.gguf` model files. */
  modelsDirectory: string
  /** Individual model files added by the user from outside the directory. */
  addedModelPaths: string[]
  /** Explicit model-path -> multimodal-projector-path associations. */
  visionProjectorPaths: Record<string, string>
  /** Path of the last successfully loaded model, restored on next launch. */
  lastModelPath?: string
  generation: GenerationSettings
  model: ModelSettings
  ui: UiSettings
  assistantStyle: AssistantStyleSettings
  profile: ProfileSettings
  appearance: AppearanceSettings
  general: GeneralSettings
  workspace: WorkspaceSettings
  tools: ToolSettings
  provider: ProviderSettings
  webSearch: WebSearchSettings
  diagnostics: DiagnosticSettings
  memory: MemorySettings
  transcriptRecall: TranscriptRecallSettings
  scheduler: SchedulerSettings
  email: EmailSettings
}

/** Recursive partial used for settings patches over IPC. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}
