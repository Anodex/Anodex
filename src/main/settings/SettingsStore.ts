import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { AppSettings, DeepPartial } from '@shared/settings.types'
import { MAX_ASSISTANT_STYLE_CHARS } from '@shared/settings.types'
import { createDefaultSettings } from '@shared/settings.defaults'
import { createLogger } from '../utils/logger'

const log = createLogger('settings')

/**
 * Persists {@link AppSettings} as JSON in Electron's `userData` directory.
 *
 * Reads are synchronous and cached in memory; writes are debounced-free but
 * cheap (single small file). Unknown keys from older/newer versions are dropped
 * on load by merging over the current defaults, which keeps the schema forward-
 * and backward-tolerant without a migration framework.
 */
class SettingsStore {
  private filePath = ''
  private modelsDirectory = ''
  private cache: AppSettings | null = null

  /** Must be called after `app.whenReady()`. */
  init(): void {
    const userData = app.getPath('userData')
    this.filePath = join(userData, 'settings.json')
    this.modelsDirectory = join(userData, 'models')
    this.ensureDir(this.modelsDirectory)
    this.cache = this.load()
    log.info('Initialised at', this.filePath)
  }

  get(): AppSettings {
    if (!this.cache) this.cache = this.load()
    return this.cache
  }

  /** Deep-merge a partial patch, persist, and return the new settings. */
  update(patch: DeepPartial<AppSettings>): AppSettings {
    validatePatch(patch)
    const previous = this.get()
    const next = deepMerge(previous, patch)
    this.cache = next
    try {
      this.persist(next)
    } catch (error) {
      this.cache = previous
      log.error('Failed to persist settings, reverted in-memory cache:', error)
      throw error
    }
    return next
  }

  private load(): AppSettings {
    const defaults = createDefaultSettings(this.modelsDirectory)
    if (!existsSync(this.filePath)) {
      try {
        this.persist(defaults)
      } catch (error) {
        log.error('Failed to write default settings:', error)
      }
      return defaults
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Record<string, unknown>
      const retired = stripRetiredGeneralSettings(parsed)
      const raw = retired.settings as DeepPartial<AppSettings> & {
        ui?: { systemPrompt?: string }
        appearance?: { themeMode?: string; presetTheme?: string }
      }
      // Merge over defaults so missing/added fields are always populated.
      const merged = deepMerge(defaults, raw)
      const migrated = migrateLegacyThemeMode(migrateLegacyAssistantStyle(merged, raw), raw)
      // Persist right away so the stray legacy fields (and, on the first pass,
      // their migrated values) only ever need handling once — left on disk,
      // they would silently re-trigger on every future load (see the
      // migration functions' own comments), undoing a later Reset of the new
      // fields.
      const legacyThemeFieldsPresent =
        raw.appearance?.themeMode !== undefined || raw.appearance?.presetTheme !== undefined
      if (raw.ui?.systemPrompt !== undefined || legacyThemeFieldsPresent || retired.changed) {
        try {
          this.persist(migrated)
        } catch (error) {
          log.error('Failed to persist settings migration:', error)
        }
      }
      return withDecryptedSecrets(migrated)
    } catch (error) {
      log.warn('Failed to parse settings, falling back to defaults:', error)
      return defaults
    }
  }

  private persist(settings: AppSettings): void {
    this.ensureDir(app.getPath('userData'))
    writeFileSync(this.filePath, JSON.stringify(withEncryptedSecrets(settings), null, 2), 'utf-8')
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

/**
 * Removes General fields that were previously displayed but never affected
 * application behavior. Keeping them in an existing settings.json would make
 * them look like supported hidden settings and allow a later save to carry
 * them forward indefinitely.
 */
export function stripRetiredGeneralSettings(settings: Record<string, unknown>): {
  settings: Record<string, unknown>
  changed: boolean
} {
  if (!isPlainObject(settings.general)) return { settings, changed: false }

  const general = { ...settings.general }
  const retiredKeys = ['startupBehavior', 'projectFolder', 'autoSave', 'defaultWorkspace']
  const changed = retiredKeys.some((key) => key in general)
  if (!changed) return { settings, changed: false }

  for (const key of retiredKeys) delete general[key]
  return { settings: { ...settings, general }, changed: true }
}

/**
 * One-time migration: `ui.systemPrompt` (an uncapped, generic free-text
 * field) was replaced by a dedicated, capped `assistantStyle.globalStyle`.
 * An existing user's old text is carried over automatically on first load
 * after upgrading, so it isn't silently discarded — but only when the new
 * field is still empty, so it never overwrites something the user has
 * already typed into the new field. Exported for unit testing; operates on
 * plain data, no store/disk access of its own.
 */
export function migrateLegacyAssistantStyle(
  settings: AppSettings,
  raw: DeepPartial<AppSettings> & { ui?: { systemPrompt?: string } }
): AppSettings {
  if (raw.ui?.systemPrompt === undefined) return settings

  // `deepMerge` carries `ui.systemPrompt` forward onto `settings.ui` even
  // though `UiSettings` no longer declares it (it blindly copies every key
  // present in a patch — see `deepMerge`'s doc comment). Strip it here
  // unconditionally, not just when migrating text below, so this only ever
  // needs handling once per legacy install: left in place, it would silently
  // re-trigger on every future load, undoing a later Reset of the new field
  // (Reset only ever clears `assistantStyle.globalStyle`, never this stray
  // field, since callers no longer know it exists).
  const ui = { ...(settings.ui as unknown as Record<string, unknown>) }
  delete ui.systemPrompt
  const cleaned = { ...settings, ui: ui as unknown as AppSettings['ui'] }

  const legacy = raw.ui.systemPrompt.trim()
  if (!legacy || settings.assistantStyle.globalStyle.trim()) return cleaned
  return {
    ...cleaned,
    assistantStyle: {
      ...cleaned.assistantStyle,
      globalStyle: legacy.slice(0, MAX_ASSISTANT_STYLE_CHARS)
    }
  }
}

/**
 * One-time migration: `appearance.themeMode` + `appearance.presetTheme` (a
 * separate overall dark/light/system mode, plus which named preset to apply
 * within it) were replaced by a single flat `appearance.theme` field —
 * Anodex no longer treats light/dark as a mode layered on top of a preset,
 * each theme is its own complete, independent choice. An existing user's old
 * `{themeMode, presetTheme}` pair is translated into the equivalent new
 * value automatically on first load after upgrading, and the retired fields
 * are stripped so they don't linger in `settings.json` forever. Exported for
 * unit testing; operates on plain data, no store/disk access of its own.
 */
export function migrateLegacyThemeMode(
  settings: AppSettings,
  raw: DeepPartial<AppSettings> & { appearance?: { themeMode?: string; presetTheme?: string } }
): AppSettings {
  const legacyMode = raw.appearance?.themeMode
  const legacyPreset = raw.appearance?.presetTheme
  if (legacyMode === undefined && legacyPreset === undefined) return settings

  // `deepMerge` carries these forward onto `settings.appearance` even though
  // `AppearanceSettings` no longer declares them (see `deepMerge`'s doc
  // comment) — strip them here so this only ever needs handling once per
  // legacy install, same reasoning as `migrateLegacyAssistantStyle` above.
  const appearance = { ...(settings.appearance as unknown as Record<string, unknown>) }
  delete appearance.themeMode
  delete appearance.presetTheme
  const cleaned = { ...settings, appearance: appearance as unknown as AppSettings['appearance'] }

  return {
    ...cleaned,
    appearance: { ...cleaned.appearance, theme: resolveLegacyTheme(legacyMode, legacyPreset) }
  }
}

function resolveLegacyTheme(
  legacyMode: string | undefined,
  legacyPreset: string | undefined
): AppSettings['appearance']['theme'] {
  if (legacyMode === 'system') return 'system'
  if (legacyMode === 'light') return legacyPreset === 'slate' ? 'slateLight' : 'midnightLight'
  if (legacyPreset === 'slate' || legacyPreset === 'obsidian' || legacyPreset === 'custom') {
    return legacyPreset
  }
  return 'midnight'
}

/** Marks a value in `settings.json` as encrypted by `safeStorage`, vs. legacy plaintext. */
const ENCRYPTED_PREFIX = 'enc:'

/**
 * Encrypts a provider/search API key with the OS credential store (Keychain,
 * DPAPI, libsecret) via `safeStorage`, so keys don't sit as plaintext in
 * `settings.json`. Falls back to leaving the value untouched when encryption
 * isn't available (e.g. some Linux setups with no keyring) — the same
 * behaviour as today, not a regression.
 */
function encryptSecret(value: string): string {
  if (!value || !safeStorage.isEncryptionAvailable()) return value
  return ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString('base64')
}

/**
 * Reverses {@link encryptSecret}. A value with no `enc:` prefix is legacy
 * plaintext from before this change (or encryption was unavailable when it
 * was saved) — returned as-is, and it will be encrypted on the next save.
 */
function decryptSecret(value: string): string {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value
  if (!safeStorage.isEncryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64'))
  } catch (error) {
    log.warn('Failed to decrypt a stored API key, treating it as unset:', error)
    return ''
  }
}

function withEncryptedSecrets(settings: AppSettings): AppSettings {
  return {
    ...settings,
    provider: {
      ...settings.provider,
      anthropic: {
        ...settings.provider.anthropic,
        apiKey: encryptSecret(settings.provider.anthropic.apiKey)
      },
      openai: {
        ...settings.provider.openai,
        apiKey: encryptSecret(settings.provider.openai.apiKey)
      }
    },
    webSearch: { ...settings.webSearch, apiKey: encryptSecret(settings.webSearch.apiKey) }
  }
}

function withDecryptedSecrets(settings: AppSettings): AppSettings {
  return {
    ...settings,
    provider: {
      ...settings.provider,
      anthropic: {
        ...settings.provider.anthropic,
        apiKey: decryptSecret(settings.provider.anthropic.apiKey)
      },
      openai: {
        ...settings.provider.openai,
        apiKey: decryptSecret(settings.provider.openai.apiKey)
      }
    },
    webSearch: { ...settings.webSearch, apiKey: decryptSecret(settings.webSearch.apiKey) }
  }
}

/** Recursively merge `patch` into `base`, returning a new object. */
function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  const output = { ...base }
  for (const key in patch) {
    const patchValue = patch[key]
    if (patchValue === undefined) continue
    const baseValue = (base as Record<string, unknown>)[key]
    if (isPlainObject(baseValue) && isPlainObject(patchValue)) {
      output[key] = deepMerge(baseValue, patchValue as DeepPartial<typeof baseValue>) as T[Extract<
        keyof T,
        string
      >]
    } else {
      output[key] = patchValue as T[Extract<keyof T, string>]
    }
  }
  return output
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Recursively rejects patch keys that don't exist anywhere in the canonical
 * settings shape. `deepMerge` trusts whatever keys survive validation, so an
 * unrecognised key — a typo, a stale field from an older version, or a bad
 * renderer-side payload — would otherwise persist to disk unnoticed.
 */
function assertKnownKeys(
  patch: Record<string, unknown>,
  reference: Record<string, unknown>,
  path = ''
): void {
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) continue
    if (!(key in reference)) {
      throw new Error(`Unknown settings key: ${path}${key}`)
    }
    const patchValue = patch[key]
    const refValue = reference[key]
    // This is an intentionally open string-to-string record. Its keys are
    // absolute model paths, so they cannot appear in the canonical defaults.
    if (`${path}${key}` === 'visionProjectorPaths') continue
    if (isPlainObject(refValue) && isPlainObject(patchValue)) {
      assertKnownKeys(patchValue, refValue, `${path}${key}.`)
    }
  }
}

/**
 * Rejects malformed patches before they reach `deepMerge`. This is the only
 * runtime check on data crossing the IPC boundary — TypeScript's compile-time
 * types don't survive `ipcMain.handle`, so a bad value here (e.g. `NaN`
 * temperature, a negative context size) would otherwise flow straight into
 * `node-llama-cpp` and fail there with a much less useful error. Exported for
 * unit testing.
 */
export function validatePatch(patch: DeepPartial<AppSettings>): void {
  assertKnownKeys(patch, createDefaultSettings('') as unknown as Record<string, unknown>)

  const generation = patch.generation
  if (generation?.temperature !== undefined) {
    if (!isFiniteNumber(generation.temperature) || generation.temperature < 0) {
      throw new Error('generation.temperature must be a non-negative finite number')
    }
  }
  if (generation?.topP !== undefined) {
    if (!isFiniteNumber(generation.topP) || generation.topP < 0 || generation.topP > 1) {
      throw new Error('generation.topP must be a finite number between 0 and 1')
    }
  }
  if (generation?.maxTokens !== undefined) {
    if (!isFiniteNumber(generation.maxTokens) || generation.maxTokens < 0) {
      throw new Error('generation.maxTokens must be a non-negative finite number')
    }
  }

  const model = patch.model
  if (model?.contextSize !== undefined) {
    if (!isFiniteNumber(model.contextSize) || model.contextSize < 0) {
      throw new Error('model.contextSize must be a non-negative finite number')
    }
  }
  if (model?.gpuLayers !== undefined) {
    if (model.gpuLayers !== 'auto' && (!isFiniteNumber(model.gpuLayers) || model.gpuLayers < 0)) {
      throw new Error('model.gpuLayers must be "auto" or a non-negative finite number')
    }
  }

  if (patch.modelsDirectory !== undefined) {
    if (typeof patch.modelsDirectory !== 'string' || patch.modelsDirectory.trim() === '') {
      throw new Error('modelsDirectory must be a non-empty string')
    }
  }

  if (patch.visionProjectorPaths !== undefined) {
    if (
      typeof patch.visionProjectorPaths !== 'object' ||
      patch.visionProjectorPaths === null ||
      Array.isArray(patch.visionProjectorPaths) ||
      Object.entries(patch.visionProjectorPaths).some(
        ([modelPath, projectorPath]) =>
          !modelPath.trim() || typeof projectorPath !== 'string' || !projectorPath.trim()
      )
    ) {
      throw new Error('visionProjectorPaths must map model paths to non-empty projector paths')
    }
  }

  if (patch.workspace?.root !== undefined && patch.workspace.root !== null) {
    if (typeof patch.workspace.root !== 'string') {
      throw new Error('workspace.root must be a string or null')
    }
  }

  if (patch.tools?.disabledTools !== undefined) {
    if (
      !Array.isArray(patch.tools.disabledTools) ||
      patch.tools.disabledTools.some((name) => typeof name !== 'string' || !name.trim())
    ) {
      throw new Error('tools.disabledTools must be an array of non-empty tool names')
    }
  }

  if (patch.appearance?.soundTheme !== undefined) {
    if (!['soft', 'crisp', 'glass', 'retro', 'sciFi'].includes(patch.appearance.soundTheme)) {
      throw new Error('appearance.soundTheme must be "soft", "crisp", "glass", "retro", or "sciFi"')
    }
  }
  if (patch.appearance?.soundVolume !== undefined) {
    if (
      !isFiniteNumber(patch.appearance.soundVolume) ||
      patch.appearance.soundVolume < 0 ||
      patch.appearance.soundVolume > 100
    ) {
      throw new Error('appearance.soundVolume must be a finite number between 0 and 100')
    }
  }

  if (patch.webSearch?.resultCount !== undefined) {
    if (!isFiniteNumber(patch.webSearch.resultCount) || patch.webSearch.resultCount < 0) {
      throw new Error('webSearch.resultCount must be a non-negative finite number')
    }
  }

  if (patch.provider?.active !== undefined) {
    if (!['local', 'anthropic', 'openai'].includes(patch.provider.active)) {
      throw new Error('provider.active must be "local", "anthropic", or "openai"')
    }
  }
  if (patch.provider?.anthropic?.model !== undefined) {
    if (
      typeof patch.provider.anthropic.model !== 'string' ||
      !patch.provider.anthropic.model.trim()
    ) {
      throw new Error('provider.anthropic.model must be a non-empty string')
    }
  }
  if (patch.provider?.openai?.model !== undefined) {
    if (typeof patch.provider.openai.model !== 'string' || !patch.provider.openai.model.trim()) {
      throw new Error('provider.openai.model must be a non-empty string')
    }
  }

  if (patch.email?.provider !== undefined) {
    if (!['none', 'gmail'].includes(patch.email.provider)) {
      throw new Error('email.provider must be "none" or "gmail"')
    }
  }
  if (patch.email?.gmail?.address !== undefined) {
    if (typeof patch.email.gmail.address !== 'string') {
      throw new Error('email.gmail.address must be a string')
    }
  }
  if (patch.email?.gmail?.oauthClientId !== undefined) {
    if (typeof patch.email.gmail.oauthClientId !== 'string') {
      throw new Error('email.gmail.oauthClientId must be a string')
    }
  }
  if (patch.email?.gmail?.oauthClientSecret !== undefined) {
    if (typeof patch.email.gmail.oauthClientSecret !== 'string') {
      throw new Error('email.gmail.oauthClientSecret must be a string')
    }
  }
  if (patch.email?.gmail?.syncMode !== undefined) {
    if (!['metadata', 'full'].includes(patch.email.gmail.syncMode)) {
      throw new Error('email.gmail.syncMode must be "metadata" or "full"')
    }
  }

  if (patch.assistantStyle?.globalStyle !== undefined) {
    if (typeof patch.assistantStyle.globalStyle !== 'string') {
      throw new Error('assistantStyle.globalStyle must be a string')
    }
    // The Settings UI enforces this via the textarea's maxLength, but a raw
    // IPC call bypasses that — enforce the same documented hard cap here too.
    if (patch.assistantStyle.globalStyle.length > MAX_ASSISTANT_STYLE_CHARS) {
      throw new Error(
        `assistantStyle.globalStyle must be at most ${MAX_ASSISTANT_STYLE_CHARS} characters`
      )
    }
  }
  if (patch.email?.gmail?.sendRequiresApproval !== undefined) {
    if (patch.email.gmail.sendRequiresApproval !== true) {
      throw new Error('email.gmail.sendRequiresApproval must be true')
    }
  }
}

export const settingsStore = new SettingsStore()
