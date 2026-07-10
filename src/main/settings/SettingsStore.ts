import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { AppSettings, DeepPartial } from '@shared/settings.types'
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
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as DeepPartial<AppSettings>
      // Merge over defaults so missing/added fields are always populated.
      return withDecryptedSecrets(deepMerge(defaults, raw))
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
 * `node-llama-cpp` and fail there with a much less useful error.
 */
function validatePatch(patch: DeepPartial<AppSettings>): void {
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

  if (patch.workspace?.root !== undefined && patch.workspace.root !== null) {
    if (typeof patch.workspace.root !== 'string') {
      throw new Error('workspace.root must be a string or null')
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
}

export const settingsStore = new SettingsStore()
