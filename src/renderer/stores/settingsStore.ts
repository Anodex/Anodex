import { create } from 'zustand'
import type { AppSettings, DeepPartial } from '@shared/settings.types'
import { anodex } from '../lib/anodex'
import { configureDiagnostics } from './diagnosticsStore'

interface SettingsState {
  settings: AppSettings | null
  loaded: boolean
  load: () => Promise<void>
  update: (patch: DeepPartial<AppSettings>) => Promise<void>
}

let updateRevision = 0

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergePatch(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = mergePatch(base[key], value)
  }
  return merged
}

/** Mirrors the persisted {@link AppSettings} from the main process. */
export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loaded: false,

  load: async () => {
    const onStartup = !get().loaded
    const settings = await anodex.settings.get()
    configureDiagnostics(settings.diagnostics, onStartup)
    set({ settings, loaded: true })
  },

  update: async (patch) => {
    const revision = ++updateRevision
    const current = get().settings
    if (current) set({ settings: mergePatch(current, patch) as AppSettings })

    try {
      const settings = await anodex.settings.update(patch)
      if (revision !== updateRevision) return
      configureDiagnostics(settings.diagnostics)
      set({ settings })
    } catch (error) {
      // Return to the main process's canonical state if the optimistic update
      // failed. Revision checks keep an older request from overwriting a newer
      // selection when IPC responses arrive out of order.
      if (revision === updateRevision) {
        const settings = await anodex.settings.get()
        if (revision === updateRevision) {
          configureDiagnostics(settings.diagnostics)
          set({ settings })
        }
      }
      throw error
    }
  }
}))
