import { app } from 'electron'
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
    const next = deepMerge(this.get(), patch)
    this.cache = next
    this.persist(next)
    return next
  }

  private load(): AppSettings {
    const defaults = createDefaultSettings(this.modelsDirectory)
    if (!existsSync(this.filePath)) {
      this.persist(defaults)
      return defaults
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as DeepPartial<AppSettings>
      // Merge over defaults so missing/added fields are always populated.
      return deepMerge(defaults, raw)
    } catch (error) {
      log.warn('Failed to parse settings, falling back to defaults:', error)
      return defaults
    }
  }

  private persist(settings: AppSettings): void {
    try {
      this.ensureDir(app.getPath('userData'))
      writeFileSync(this.filePath, JSON.stringify(settings, null, 2), 'utf-8')
    } catch (error) {
      log.error('Failed to persist settings:', error)
    }
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
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

export const settingsStore = new SettingsStore()
