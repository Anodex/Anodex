import { app } from 'electron'
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
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as DeepPartial<AppSettings>
      // Merge over defaults so missing/added fields are always populated.
      const merged = deepMerge(defaults, raw)
      return migrateLegacyAssistantStyle(merged, raw)
    } catch (error) {
      log.warn('Failed to parse settings, falling back to defaults:', error)
      return defaults
    }
  }

  private persist(settings: AppSettings): void {
    this.ensureDir(app.getPath('userData'))
    writeFileSync(this.filePath, JSON.stringify(settings, null, 2), 'utf-8')
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
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
  const legacy = raw.ui?.systemPrompt?.trim()
  if (!legacy || settings.assistantStyle.globalStyle.trim()) return settings
  return {
    ...settings,
    assistantStyle: {
      ...settings.assistantStyle,
      globalStyle: legacy.slice(0, MAX_ASSISTANT_STYLE_CHARS)
    }
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
 * Rejects malformed patches before they reach `deepMerge`. This is the only
 * runtime check on data crossing the IPC boundary — TypeScript's compile-time
 * types don't survive `ipcMain.handle`, so a bad value here (e.g. `NaN`
 * temperature, a negative context size) would otherwise flow straight into
 * `node-llama-cpp` and fail there with a much less useful error.
 */
function validatePatch(patch: DeepPartial<AppSettings>): void {
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
  if (patch.email?.gmail?.sendRequiresApproval !== undefined) {
    if (patch.email.gmail.sendRequiresApproval !== true) {
      throw new Error('email.gmail.sendRequiresApproval must be true')
    }
  }
}

export const settingsStore = new SettingsStore()
