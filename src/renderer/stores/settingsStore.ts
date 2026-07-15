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
    const settings = await anodex.settings.update(patch)
    configureDiagnostics(settings.diagnostics)
    set({ settings })
  }
}))
