/** Persisted application settings. */

import type { EmailAccount } from './email.types'

export interface GenerationSettings {
  temperature: number
  topP: number
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
   *
   * Deliberately required, and seeded `false` by `createDefaultSettings`, for
   * two reasons: `validatePatch` builds its allow-list of legal patch keys from
   * the defaults, so a field missing there is rejected on the way back in over
   * IPC; and the startup sequence tests it with `=== false` to tell a
   * never-configured install apart from settings that simply haven't loaded
   * yet, which only works if a real `false` is present.
   */
  autoConfigured: boolean
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

/**
 * Deliberately holds no email address: the one shown on the profile is the
 * primary linked account's, read from `email.accounts`. A second, hand-typed
 * copy would drift the moment an account is unlinked or the default changes.
 */
export interface ProfileSettings {
  /** Display name shown in the UI header and settings. */
  displayName: string
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
  /**
   * Hard ceiling on tokens generated per reply for this provider; `null`
   * leaves it to the provider (the local engine sizes each turn against the
   * room its context actually has; a cloud provider uses its own default).
   * See `LocalProviderSettings.maxResponseTokens` for why local defaults off.
   */
  maxResponseTokens: number | null
}

export interface OpenAiProviderSettings {
  /** User's OpenAI API key. Stored locally in settings, same as the web search provider keys. */
  apiKey: string
  /** OpenAI model id used for chat generations, e.g. `gpt-5.6` or `gpt-5.1-codex`. */
  model: string
  /** Self-imposed daily token budget for this provider; `null` means no cap. Warn-only — never blocks a send. */
  dailyTokenCap: number | null
  /**
   * Hard ceiling on tokens generated per reply for this provider; `null`
   * leaves it to the provider (the local engine sizes each turn against the
   * room its context actually has; a cloud provider uses its own default).
   * See `LocalProviderSettings.maxResponseTokens` for why local defaults off.
   */
  maxResponseTokens: number | null
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
  /**
   * Hard ceiling on tokens generated per reply for this provider; `null`
   * leaves it to the provider (the local engine sizes each turn against the
   * room its context actually has; a cloud provider uses its own default).
   * See `LocalProviderSettings.maxResponseTokens` for why local defaults off.
   */
  maxResponseTokens: number | null
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
  /**
   * Hard ceiling on tokens generated per reply for this provider; `null`
   * leaves it to the provider (the local engine sizes each turn against the
   * room its context actually has; a cloud provider uses its own default).
   * See `LocalProviderSettings.maxResponseTokens` for why local defaults off.
   */
  maxResponseTokens: number | null
}

/**
 * The local engine's own provider settings. It has no API key, model id, or
 * daily cap — nothing here is billed — so `maxResponseTokens` is the only
 * field, and it defaults to `null` (off).
 *
 * Off is the right default locally because a user-set ceiling can only ever
 * *lower* what `resolveLocalOutputBudget` already measured this turn has room
 * for, and there is no cost to bound in exchange. A ceiling set too low does
 * not degrade gracefully: a tool call cut short mid-arguments cannot be parsed
 * and loses the whole turn. It stays configurable for anyone who wants to cap
 * reply length deliberately.
 */
export interface LocalProviderSettings {
  maxResponseTokens: number | null
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
  local: LocalProviderSettings
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
  category: 'model' | 'provider' | 'integration' | 'file' | 'permission' | 'runtime' | 'general'
  message: string
  detail?: string
  suggestedFix?: string
  /**
   * Which process raised it. `main` entries come from background services (the
   * local engine, mailboxes, MCP, the updater) and carry full stacks; `renderer`
   * entries are raised by the UI itself. Absent on entries stored before this
   * distinction existed — treat as `renderer`.
   */
  source?: 'main' | 'renderer'
  /** Logger scope for a `main` entry, e.g. `llama` or `email:imap`. */
  scope?: string
}

export interface DiagnosticSettings {
  /** Number of recent diagnostic entries to keep in memory. */
  maxEntries: number
  /** Auto-clear info entries on app restart. */
  clearOnRestart: boolean
  /** Include verbose debug entries (not implemented yet). */
  verbose: boolean
}

/** Where the main-process log file lives, for the Diagnostics page. */
export interface DiagnosticLogFile {
  path: string
  sizeBytes: number
  /** False when file logging could not be started (the reason is on stderr). */
  available: boolean
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

export type KeyboardShortcutId =
  | 'newChat'
  | 'newProject'
  | 'goChat'
  | 'goScheduler'
  | 'goAgent'
  | 'goCriticalThinking'
  | 'goEmail'
  | 'searchSidebar'
  | 'openSettings'
  | 'toggleSidebar'
  | 'toggleWorkspaceDock'
  | 'focusComposer'
  | 'stopGeneration'
  | 'showShortcutHelp'
  | 'toggleDockPlan'
  | 'toggleDockFiles'
  | 'toggleDockTerminal'

export type KeyboardShortcutMap = Record<KeyboardShortcutId, string>

export interface KeyboardSettings {
  /**
   * User-editable app shortcuts. Empty string disables a shortcut. Values use
   * a normalized display form such as "Ctrl+Shift+P".
   */
  shortcuts: KeyboardShortcutMap
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
  keyboard: KeyboardSettings
  email: EmailSettings
}

/** Recursive partial used for settings patches over IPC. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

/**
 * Settings that accept an explicit `null` in a patch to mean "remove this key".
 *
 * Patches are deep-merged, which can only add or overwrite keys — never shrink
 * a record or clear an optional field. Without a sentinel, a caller that copies
 * a record, deletes an entry and patches the result silently gets the entry
 * restored from the base object.
 *
 * Deliberately an allowlist: other settings store a meaningful `null`
 * (`workspace.root`, `profile.avatarBase64`) that must survive the merge. A
 * trailing `.*` marks an open record whose entries are all individually
 * removable.
 */
export const REMOVABLE_SETTING_PATHS: ReadonlySet<string> = new Set([
  'lastModelPath',
  'visionProjectorPaths.*'
])

/**
 * True when `null` at `parentPath` + `key` means "delete this key". `parentPath`
 * is dot-terminated (`''` at the top level); keys are matched whole rather than
 * by splitting the joined path, because open-record keys are absolute file paths
 * that contain dots of their own.
 */
export function isRemovableSetting(parentPath: string, key: string): boolean {
  if (REMOVABLE_SETTING_PATHS.has(`${parentPath}${key}`)) return true
  return parentPath !== '' && REMOVABLE_SETTING_PATHS.has(`${parentPath}*`)
}

/**
 * The shape accepted by `settingsStore.update`: a {@link DeepPartial} except
 * that {@link REMOVABLE_SETTING_PATHS} also accept `null` to delete a key.
 */
export type SettingsPatch = Omit<
  DeepPartial<AppSettings>,
  'lastModelPath' | 'visionProjectorPaths'
> & {
  /** `null` clears the stored path, e.g. when that model file is deleted. */
  lastModelPath?: string | null
  /** A `null` value removes that model's projector association entirely. */
  visionProjectorPaths?: Record<string, string | null>
}
