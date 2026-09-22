import type { ChatPersonality } from './chatPersonality'

/** Persisted application settings. */

import type { EmailAccount } from './email.types'
import type { ContextAssemblyStrategy } from './contextPlanner'

export interface GenerationSettings {
  temperature: number
  topP: number
  /**
   * Context projection implementation. current remains the immediate rollback
   * path; adaptive-v1 packs automatic supporting material into one
   * capacity-aware allowance without changing enabled capabilities.
   */
  contextAssemblyStrategy: ContextAssemblyStrategy
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
   * How many things the local model may work on at once: 1 (off), 2 or 3.
   *
   * Takes effect when a model loads. Honoured by models that load through the
   * multimodal runtime, where jobs share one pool of context memory; a text-only
   * model still runs one job at a time.
   */
  parallelJobs: number
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
   *
   * In force only when no personality is selected — see
   * `resolveActiveStyle` in `src/shared/chatPersonality.ts`, which is the one
   * place that decides between this and `activePersonalityId`.
   */
  globalStyle: string
  /**
   * The user's own named personalities. Shipped built-ins are deliberately
   * absent: they live in code and are merged in at read time, so deleting one
   * is impossible and a reworded release cannot leave a stale copy behind.
   */
  personalities: ChatPersonality[]
  /**
   * Which personality is in force, or null for the free-text `globalStyle`.
   *
   * May name a personality that no longer exists — deleting the one you were
   * using is ordinary — and `resolveActiveStyle` treats that as "none".
   */
  activePersonalityId: string | null
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
  /**
   * Ask a project chat that changed files to check them before it finishes: a build,
   * test or lint run, a syntax check, or a look at a changed page. Once per reply.
   * Missing (settings written before this existed) reads as on.
   */
  checkBeforeFinishing?: boolean
}

/**
 * Explicit authorization for a future native desktop-control backend. This is
 * intentionally separate from ordinary tool permission mode and starts off.
 */
export interface ComputerControlSettings {
  desktopControlEnabled: boolean
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
  /** OpenAI model id used for chat generations, e.g. `gpt-5.6` or `gpt-5.3-codex`. */
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
 * daily cap — nothing here is billed — so the reply ceiling and the context
 * replay mode are the only fields, and both default to `null` (off).
 *
 * Off is the right default for the reply ceiling locally because a user-set
 * ceiling can only ever *lower* what `resolveLocalOutputBudget` already
 * measured this turn has room for, and there is no cost to bound in exchange.
 * A ceiling set too low does not degrade gracefully: a tool call cut short
 * mid-arguments cannot be parsed and loses the whole turn. It stays
 * configurable for anyone who wants to cap reply length deliberately.
 */
export interface LocalProviderSettings {
  maxResponseTokens: number | null
  /**
   * Replay ceiling for the local engine's model-facing history. `null` is Full
   * recall — the historical greedy behaviour, where history fills the whole
   * context budget and a rebuilt session starts near the compaction trigger.
   * A fraction (see `DEFAULT_RECALL_WINDOW_FRACTION`) is the bounded recall
   * window: only that share of the budget replays verbatim, while older turns
   * are summarized instead. This is an internal migration seam; the user
   * does not select between separate context systems.
   */
  recallWindowFraction: number | null
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
  /**
   * When the operation behind this entry later succeeded.
   *
   * A background failure that has since fixed itself — the mailbox that
   * reconnected, the model that loaded on the second go — stays in the list as a
   * record of what happened, but stops counting as something to attend to. Only
   * absence of this field means "still wrong".
   */
  resolvedAt?: number
  /**
   * The version of Anodex this happened on.
   *
   * Entries are kept in the window's own storage, so they outlive the update that
   * fixed them: on the machine this was found, Diagnostics said "7 unresolved errors"
   * while the log had none since two updates earlier. An entry from an older version
   * is let go at startup — if the fault is still there, this version records it again.
   * Absent on entries stored before this existed, which is treated as older.
   */
  appVersion?: string
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

/**
 * What Anodex is holding in memory right now, for the Diagnostics page.
 *
 * Added because the question "why is it using this much?" had no answer anywhere in
 * the app: the only way to look was Task Manager, which says one number for a process
 * and nothing about what is in it.
 */
export interface MemoryUsageReport {
  /** Each of the app's own processes, as Electron reports them. */
  processes: Array<{ kind: string; detail?: string; bytes: number }>
  /** The main process's JavaScript heap, inside its `rss`. */
  mainHeapBytes: number
  mainRssBytes: number
  /** The big things the main process holds, each with what it is. */
  holders: MemoryHolder[]
}

export interface MemoryHolder {
  name: string
  detail: string
  /** Best estimate in bytes, or null when the size is not knowable cheaply. */
  bytes: number | null
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

export interface UpdateSettings {
  /**
   * Install a new version without being asked, once nothing is running.
   *
   * Off by default, and deliberately: installing quits Anodex and starts it
   * again, which is not a thing to do to somebody unannounced. On, it is for a
   * machine that is left working — four releases sat waiting on a click here
   * overnight while the work that needed them carried on against the old build.
   *
   * What counts as nothing running is `nothingInFlight` in `quietMoment.ts`. The
   * signature check that gates a manual install gates this one too: an update
   * that fails it is never run, asked for or not.
   *
   * Missing (settings written before this existed) reads as off.
   */
  automatic?: boolean
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

export interface AgentSettings {
  /**
   * Whether an agent run may delegate parts of its work to sub-agents.
   *
   * Off by default. Delegation multiplies what one run costs and how much it
   * does unattended, and both of those should be a decision rather than a
   * surprise — a goal that quietly became four runs is not what someone
   * pressing Start agreed to.
   */
  subAgentsEnabled: boolean
  /**
   * Which provider each sub-agent runs on, by position.
   *
   * Empty means every sub-agent inherits the run's own provider, which is
   * the old behaviour. Otherwise the first sub-agent takes the first entry,
   * the second the second, and a fan-out wider than the list wraps around.
   *
   * Two reasons this is worth configuring rather than inheriting.
   *
   * The dull one is that it removes the deadlock. The local engine
   * serialises generation behind a gate the parent holds for its whole turn,
   * so local children wait for a slot the parent cannot release. Children on
   * a cloud provider never touch that gate, so a local run can delegate
   * freely as long as its sub-agents are elsewhere.
   *
   * The interesting one is that different models have different blind spots.
   * Same-model sub-agents divide the work; different-model sub-agents
   * genuinely disagree, and a review is exactly the task where that is worth
   * paying for.
   */
  subAgentProviders: string[]
}

export interface SpendingSettings {
  /**
   * Whether a provider's daily token cap refuses a send or only warns.
   *
   * The cap is per provider because the numbers differ; this policy is
   * global because wanting a cap to *mean* different things on different
   * providers is not a real need, and eleven copies of one toggle is eleven
   * chances for one to be wrong. See `shared/dailyCap.ts`.
   *
   * Off by default: the caps already in people's settings were set against a
   * row that says "It never blocks a message", and turning them into hard
   * stops under someone would be a surprise with a bill attached.
   */
  stopAtDailyCap: boolean
}

export interface GitSettings {
  /**
   * Add a `Co-Authored-By: Anodex` trailer to commits Anodex writes.
   *
   * On by default: a commit an assistant wrote should say so, and the trailer
   * is git's own way of saying it. See `shared/commitAttribution.ts` for what
   * GitHub needs before the credit renders with an avatar.
   */
  attributeCommits: boolean
  /** The address in that trailer; blank falls back to the built-in one. */
  attributionEmail: string
}

export interface AppSettings {
  /** Directory scanned for `.gguf` model files. */
  modelsDirectory: string
  /** Individual model files added by the user from outside the directory. */
  addedModelPaths: string[]
  /** Explicit model-path -> multimodal-projector-path associations. */
  visionProjectorPaths: Record<string, string>
  /**
   * Context size chosen for one specific model file, keyed by its path.
   *
   * `model.contextSize` is a single global number, but a context size is only
   * ever meaningful for the model it was sized against — "Apply recommendation"
   * reads that file's own GGUF metadata. Writing that result globally silently
   * re-sized every *other* model: sizing a 27B vision model down to 8,192 left
   * a small coding model running at 8,192 too, with a 427-token history budget
   * and no warning anywhere, because the running size still matched the saved
   * setting exactly.
   *
   * An entry here wins over `model.contextSize` when that model loads. Absent
   * for any model whose size was never chosen deliberately, which keeps the
   * global setting meaningful as the default for everything else.
   */
  modelContextSizes: Record<string, number>
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
  computerControl: ComputerControlSettings
  provider: ProviderSettings
  webSearch: WebSearchSettings
  diagnostics: DiagnosticSettings
  memory: MemorySettings
  transcriptRecall: TranscriptRecallSettings
  scheduler: SchedulerSettings
  updates: UpdateSettings
  keyboard: KeyboardSettings
  email: EmailSettings
  git: GitSettings
  spending: SpendingSettings
  agents: AgentSettings
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
  'visionProjectorPaths.*',
  'modelContextSizes.*'
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
  'lastModelPath' | 'visionProjectorPaths' | 'modelContextSizes'
> & {
  /** `null` clears the stored path, e.g. when that model file is deleted. */
  lastModelPath?: string | null
  /** A `null` value removes that model's projector association entirely. */
  visionProjectorPaths?: Record<string, string | null>
  /** A `null` value forgets that model's size, falling back to `model.contextSize`. */
  modelContextSizes?: Record<string, number | null>
}
