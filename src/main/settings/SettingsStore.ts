import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { AppSettings, DeepPartial, SettingsPatch } from '@shared/settings.types'
import type { EmailAccount } from '@shared/email.types'
import { MAX_ASSISTANT_STYLE_CHARS, isRemovableSetting } from '@shared/settings.types'
import { createDefaultSettings } from '@shared/settings.defaults'
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  isBindableShortcut,
  normalizeShortcut
} from '@shared/keyboardShortcuts'
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

  /**
   * Deep-merge a partial patch, persist, and return the new settings. A `null`
   * at one of the `REMOVABLE_SETTING_PATHS` deletes that key instead of storing
   * a value — the only way to shrink a setting, since the merge itself can only
   * add and overwrite.
   */
  update(patch: SettingsPatch): AppSettings {
    validatePatch(patch)
    const previous = this.get()
    // The removal sentinel is what makes `SettingsPatch` wider than
    // `DeepPartial`; `deepMerge` handles it explicitly, hence the cast.
    const next = deepMerge(previous, patch as DeepPartial<AppSettings>)
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
        email?: LegacyEmailSettings
      }
      // Merge over defaults so missing/added fields are always populated.
      const merged = deepMerge(defaults, raw)
      const migrated = migrateLegacyMaxTokens(
        migrateLegacyGmailAccount(
          migrateLegacyThemeMode(migrateLegacyAssistantStyle(merged, raw), raw),
          raw
        ),
        raw
      )
      // Persist right away so the stray legacy fields (and, on the first pass,
      // their migrated values) only ever need handling once — left on disk,
      // they would silently re-trigger on every future load (see the
      // migration functions' own comments), undoing a later Reset of the new
      // fields.
      const legacyThemeFieldsPresent =
        raw.appearance?.themeMode !== undefined || raw.appearance?.presetTheme !== undefined
      const legacyEmailFieldsPresent =
        raw.email?.provider !== undefined || raw.email?.gmail !== undefined
      if (
        raw.ui?.systemPrompt !== undefined ||
        legacyThemeFieldsPresent ||
        legacyEmailFieldsPresent ||
        (raw.generation as { maxTokens?: number } | undefined)?.maxTokens !== undefined ||
        retired.changed
      ) {
        try {
          // `persist` encrypts what it is given, and `migrated` still holds the
          // ciphertext read off disk — decryption happens on the way out, below.
          // Handing it over as-is encrypted the keys a second time, so the next
          // load decrypted one layer and returned `enc:…` as the API key.
          this.persist(withDecryptedSecrets(migrated))
        } catch (error) {
          log.error('Failed to persist settings migration:', error)
        }
      }
      return withDecryptedSecrets(migrated)
    } catch (error) {
      // Falling back to defaults is right — the app has to start. Doing it
      // silently was not: nothing overwrites `settings.json` at this point, but
      // the very next `update()` persists the defaults straight over it, and
      // every API key, every linked mail account and every preference in the
      // unreadable file is gone with no copy anywhere. Moved aside first, the
      // same way `CheckpointStore` handles a checkpoint it cannot parse, so the
      // keys are still recoverable by hand.
      this.quarantine(error)
      return defaults
    }
  }

  /** Move an unreadable settings file aside, best effort. */
  private quarantine(error: unknown): void {
    const aside = `${this.filePath}.corrupt`
    try {
      renameSync(this.filePath, aside)
      log.warn(`Could not parse settings; moved to ${aside} and started from defaults.`, error)
    } catch (renameError) {
      log.error(
        'Could not parse settings and could not move the file aside — the next save will ' +
          'overwrite it with defaults:',
        renameError
      )
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
/**
 * Moves the retired global `generation.maxTokens` onto each cloud provider's
 * own `maxResponseTokens`.
 *
 * The old setting was one number applied to every backend at once. It earned
 * its place for cloud providers, where output tokens are billed and a ceiling
 * is a real cost lever, so each of them inherits whatever value was configured
 * — silently changing a cost-affecting setting during an upgrade would be
 * worse than carrying it forward.
 *
 * The local engine deliberately does **not** inherit it (see
 * `LocalProviderSettings.maxResponseTokens`). Locally the value could only
 * lower a ceiling the engine already measures correctly, and a value too low
 * loses whole turns to tool calls cut off mid-arguments — which is exactly
 * what it was doing before this move.
 */
export function migrateLegacyMaxTokens(
  settings: AppSettings,
  raw: DeepPartial<AppSettings> & { generation?: { maxTokens?: number } }
): AppSettings {
  const legacy = raw.generation?.maxTokens
  // `deepMerge` carries the retired key forward onto `settings.generation`
  // even though `GenerationSettings` no longer declares it — strip it either
  // way, so this only ever needs handling once per install.
  const generation = { ...(settings.generation as unknown as Record<string, unknown>) }
  delete generation.maxTokens
  const cleaned = {
    ...settings,
    generation: generation as unknown as AppSettings['generation']
  }
  if (!isFiniteNumber(legacy) || legacy <= 0) return cleaned

  const provider = { ...cleaned.provider }
  for (const key of Object.keys(provider) as Array<keyof typeof provider>) {
    if (key === 'active' || key === 'local') continue
    const existing = provider[key] as { maxResponseTokens?: number | null }
    // Only seed providers that haven't been given their own value already.
    if (existing.maxResponseTokens == null) {
      provider[key] = { ...existing, maxResponseTokens: legacy } as never
    }
  }
  return { ...cleaned, provider }
}

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

/**
 * Account id given to a migrated single-Gmail setup. It deliberately matches
 * the provider key that {@link EmailAuthStore} used before tokens were keyed by
 * account, so the existing OAuth token keeps resolving with no token-store
 * migration of its own.
 */
export const LEGACY_GMAIL_ACCOUNT_ID = 'gmail'

/** The pre-multi-account `email` block, as it still exists on disk for upgraders. */
export interface LegacyEmailSettings {
  provider?: string
  gmail?: {
    enabled?: boolean
    address?: string
    oauthClientId?: string
    oauthClientSecret?: string
    syncMode?: string
  }
}

/**
 * One-time migration: `email.{provider,gmail}` (a single hardcoded Gmail
 * account) was replaced by `email.accounts`, a list that also holds Microsoft
 * and IMAP accounts. A configured legacy Gmail account becomes the first entry
 * and the primary, keeping an already-authorized user connected across the
 * upgrade.
 *
 * `oauthClientSecret` is intentionally dropped rather than carried over: it sat
 * in `settings.json` as plaintext, and the OAuth flow now uses PKCE, which is
 * what RFC 8252 prescribes for native apps and needs no secret. A user with a
 * custom client that still requires one re-enters it, and it goes to
 * `EmailAuthStore` instead of settings.
 *
 * Exported for unit testing; operates on plain data, no store/disk access.
 */
export function migrateLegacyGmailAccount(
  settings: AppSettings,
  raw: DeepPartial<AppSettings> & { email?: LegacyEmailSettings }
): AppSettings {
  const legacy = raw.email
  if (!legacy || (legacy.provider === undefined && legacy.gmail === undefined)) return settings

  // `deepMerge` copies the retired `provider`/`gmail` keys onto `settings.email`
  // even though `EmailSettings` no longer declares them (see `deepMerge`'s doc
  // comment) — strip them so this only runs once per legacy install, the same
  // reasoning as the two migrations above.
  const email = { ...(settings.email as unknown as Record<string, unknown>) }
  delete email.provider
  delete email.gmail
  const cleaned = {
    ...settings,
    email: email as unknown as AppSettings['email']
  }

  // Never overwrite accounts that already exist — a second pass (or a settings
  // file touched by a newer build) must not resurrect the legacy account.
  if (cleaned.email.accounts.length > 0) return cleaned

  const gmail = legacy.gmail
  const address = typeof gmail?.address === 'string' ? gmail.address.trim() : ''
  const oauthClientId = typeof gmail?.oauthClientId === 'string' ? gmail.oauthClientId.trim() : ''
  const configured = gmail?.enabled === true || address !== '' || oauthClientId !== ''
  if (!configured) return cleaned

  const account: EmailAccount = {
    id: LEGACY_GMAIL_ACCOUNT_ID,
    provider: 'gmail',
    address,
    displayName: address || 'Gmail',
    authKind: 'oauth',
    syncMode: gmail?.syncMode === 'full' ? 'full' : 'metadata',
    createdAt: Date.now()
  }
  if (oauthClientId) account.oauthClientId = oauthClientId

  return {
    ...cleaned,
    email: {
      ...cleaned.email,
      accounts: [account],
      primaryAccountId: account.id
    }
  }
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
  // Already encrypted. A real key never starts with this prefix, and wrapping a
  // second time is not a harmless no-op: one `decryptSecret` on the way back out
  // strips one layer only, so the caller is handed `enc:…` and authenticates
  // with it. Idempotent here so no future caller can corrupt a key by passing
  // ciphertext to something that expects plaintext.
  if (value.startsWith(ENCRYPTED_PREFIX)) return value
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

/**
 * Recursively merge `patch` into `base`, returning a new object.
 *
 * `path` is the dot-terminated position of `base` within {@link AppSettings}
 * (`''` at the root) and exists only to recognise the removal sentinel: at a
 * {@link isRemovableSetting} position an explicit `null` deletes the key rather
 * than being stored. Everywhere else the merge is add-or-overwrite only, so a
 * key present in `base` always survives.
 */
function deepMerge<T>(base: T, patch: DeepPartial<T>, path = ''): T {
  const output = { ...base }
  for (const key in patch) {
    const patchValue = patch[key]
    if (patchValue === undefined) continue
    if (patchValue === null && isRemovableSetting(path, key)) {
      delete (output as Record<string, unknown>)[key]
      continue
    }
    const baseValue = (base as Record<string, unknown>)[key]
    if (isPlainObject(baseValue) && isPlainObject(patchValue)) {
      output[key] = deepMerge(
        baseValue,
        patchValue as DeepPartial<typeof baseValue>,
        `${path}${key}.`
      ) as T[Extract<keyof T, string>]
    } else {
      output[key] = patchValue as T[Extract<keyof T, string>]
    }
  }
  return output
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Every backend that may be `provider.active`, taken from the settings shape
 * itself: `ProviderSettings` holds one block per backend alongside `active`, so
 * the keys either side of that are exactly the valid choices, and adding a
 * provider cannot leave this behind.
 */
function validProviderIds(): string[] {
  return Object.keys(createDefaultSettings('').provider).filter((key) => key !== 'active')
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
    if (isPlainObject(refValue)) {
      // A whole settings block replaced by a scalar or an array. `deepMerge`
      // only recurses when both sides are objects, so it would take the value
      // wholesale — `{ provider: 'x' }` leaves `settings.provider` a string,
      // persists it, and every read of `provider.anthropic.apiKey` throws from
      // then on, across restarts, until the file is deleted by hand. `null`
      // stays allowed: that is the removal sentinel, which `deepMerge` handles.
      if (patchValue === null) continue
      if (!isPlainObject(patchValue)) {
        throw new Error(`Settings key ${path}${key} must be an object`)
      }
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
export function validatePatch(patch: SettingsPatch): void {
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
  for (const [name, entry] of Object.entries(patch.provider ?? {})) {
    if (name === 'active' || typeof entry !== 'object' || entry === null) continue
    const cap = (entry as { maxResponseTokens?: unknown }).maxResponseTokens
    if (cap === undefined || cap === null) continue
    if (!isFiniteNumber(cap) || cap < 1) {
      throw new Error(`provider.${name}.maxResponseTokens must be null or a positive number`)
    }
  }
  if (generation?.turnTimeLimitMinutes !== undefined && generation.turnTimeLimitMinutes !== null) {
    if (
      !isFiniteNumber(generation.turnTimeLimitMinutes) ||
      generation.turnTimeLimitMinutes < 1 ||
      generation.turnTimeLimitMinutes > 120
    ) {
      throw new Error('generation.turnTimeLimitMinutes must be null or a number between 1 and 120')
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
          // `null` is the removal sentinel (see `REMOVABLE_SETTING_PATHS`), so
          // it is the one non-string value this record accepts.
          !modelPath.trim() ||
          (projectorPath !== null && (typeof projectorPath !== 'string' || !projectorPath.trim()))
      )
    ) {
      throw new Error('visionProjectorPaths must map model paths to non-empty projector paths')
    }
  }

  if (patch.lastModelPath !== undefined && patch.lastModelPath !== null) {
    if (typeof patch.lastModelPath !== 'string' || !patch.lastModelPath.trim()) {
      throw new Error('lastModelPath must be a non-empty string or null')
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

  if (patch.keyboard?.shortcuts !== undefined) {
    if (!isPlainObject(patch.keyboard.shortcuts)) {
      throw new Error('keyboard.shortcuts must be an object')
    }
    for (const [id, value] of Object.entries(patch.keyboard.shortcuts)) {
      if (!(id in DEFAULT_KEYBOARD_SHORTCUTS)) {
        throw new Error(`keyboard.shortcuts contains an unknown shortcut: ${id}`)
      }
      if (typeof value !== 'string') {
        throw new Error(`keyboard.shortcuts.${id} must be a string`)
      }
      if (value && normalizeShortcut(value) !== value) {
        throw new Error(`keyboard.shortcuts.${id} must use normalized shortcut syntax`)
      }
      if (value && !isBindableShortcut(value)) {
        throw new Error(
          `keyboard.shortcuts.${id} needs a Ctrl, Alt, or Meta modifier (or Escape / an F-key)`
        )
      }
    }
    // Two actions on one binding would fire both. The settings UI blocks this,
    // but the IPC channel is the real boundary.
    const claimed = new Map<string, string>()
    for (const [id, value] of Object.entries(patch.keyboard.shortcuts)) {
      if (typeof value !== 'string' || !value) continue
      const owner = claimed.get(value)
      if (owner)
        throw new Error(`keyboard.shortcuts: ${value} is assigned to both ${owner} and ${id}`)
      claimed.set(value, id)
    }
  }

  if (patch.provider?.active !== undefined) {
    // Derived from the settings shape rather than listed by hand. The hand-
    // written list said `local`, `anthropic`, `openai` and was never extended
    // as the other nine were added, so connecting Google, xAI, DeepSeek,
    // Mistral, Groq, OpenRouter, Azure, Kimi or Qwen worked but pressing "Use
    // for chat" threw — every one of them is offered by the Provider
    // Connections panel, which patches exactly this field. `ProviderSettings`
    // carries one settings block per backend, so its own keys are the list.
    const known = validProviderIds()
    if (!known.includes(patch.provider.active)) {
      throw new Error(`provider.active must be one of ${known.join(', ')}`)
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

  if (patch.email?.accounts !== undefined) validateEmailAccounts(patch.email.accounts)
  if (patch.email?.primaryAccountId !== undefined && patch.email.primaryAccountId !== null) {
    if (typeof patch.email.primaryAccountId !== 'string' || !patch.email.primaryAccountId.trim()) {
      throw new Error('email.primaryAccountId must be a non-empty string or null')
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
  if (patch.email?.sendRequiresApproval !== undefined) {
    if (patch.email.sendRequiresApproval !== true) {
      throw new Error('email.sendRequiresApproval must be true')
    }
  }
}

/**
 * Accounts normally arrive from `EmailAccountStore`, which builds them itself —
 * but `settings:update` is reachable from the renderer with an arbitrary
 * payload, so the shape is checked here rather than trusted. Rejecting a
 * credential-looking key is deliberate: secrets belong in `EmailAuthStore`, and
 * anything landing in an account record is written to disk as plaintext.
 */
function validateEmailAccounts(accounts: unknown): void {
  if (!Array.isArray(accounts)) throw new Error('email.accounts must be an array')
  const seen = new Set<string>()
  for (const account of accounts) {
    if (!isPlainObject(account)) throw new Error('email.accounts entries must be objects')
    if (typeof account.id !== 'string' || !account.id.trim()) {
      throw new Error('email.accounts[].id must be a non-empty string')
    }
    if (seen.has(account.id)) throw new Error(`email.accounts[].id is duplicated: ${account.id}`)
    seen.add(account.id)
    if (typeof account.provider !== 'string' || !EMAIL_PROVIDERS.includes(account.provider)) {
      throw new Error(`email.accounts[].provider must be one of ${EMAIL_PROVIDERS.join(', ')}`)
    }
    if (typeof account.address !== 'string' || !account.address.trim()) {
      throw new Error('email.accounts[].address must be a non-empty string')
    }
    if (account.authKind !== 'oauth' && account.authKind !== 'password') {
      throw new Error('email.accounts[].authKind must be "oauth" or "password"')
    }
    if (account.syncMode !== 'metadata' && account.syncMode !== 'full') {
      throw new Error('email.accounts[].syncMode must be "metadata" or "full"')
    }
    for (const key of ['password', 'oauthClientSecret', 'accessToken', 'refreshToken']) {
      if (key in account) {
        throw new Error(`email.accounts[] must not carry a credential field: ${key}`)
      }
    }
    for (const key of ['imap', 'smtp'] as const) {
      if (account[key] !== undefined) validateEmailEndpoint(account[key], key)
    }
  }
}

const EMAIL_PROVIDERS = ['gmail', 'microsoft', 'imap']

function validateEmailEndpoint(endpoint: unknown, label: string): void {
  if (!isPlainObject(endpoint)) throw new Error(`email.accounts[].${label} must be an object`)
  if (typeof endpoint.host !== 'string' || !endpoint.host.trim()) {
    throw new Error(`email.accounts[].${label}.host must be a non-empty string`)
  }
  if (!isFiniteNumber(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
    throw new Error(`email.accounts[].${label}.port must be a port number`)
  }
  if (!['tls', 'starttls', 'plain'].includes(endpoint.security as string)) {
    throw new Error(`email.accounts[].${label}.security must be "tls", "starttls", or "plain"`)
  }
  if (typeof endpoint.username !== 'string' || !endpoint.username.trim()) {
    throw new Error(`email.accounts[].${label}.username must be a non-empty string`)
  }
}

export const settingsStore = new SettingsStore()
