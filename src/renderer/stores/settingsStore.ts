import { create } from 'zustand'
import type { AppSettings, DeepPartial } from '@shared/settings.types'
import { anodex } from '../lib/anodex'

interface SettingsState {
  settings: AppSettings | null
  loaded: boolean
  load: () => Promise<void>
  update: (patch: DeepPartial<AppSettings>) => Promise<void>
}

/** Mirrors the persisted {@link AppSettings} from the main process. */
export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  loaded: false,

  load: async () => {
    const settings = await anodex.settings.get()
    set({ settings, loaded: true })
  },

  update: async (patch) => {
    const settings = await anodex.settings.update(patch)
    set({ settings })
  }
}))
