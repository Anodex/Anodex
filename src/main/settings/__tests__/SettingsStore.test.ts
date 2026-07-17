import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/settings.types'
import { MAX_ASSISTANT_STYLE_CHARS } from '@shared/settings.types'
import { createDefaultSettings } from '@shared/settings.defaults'
import {
  migrateLegacyAssistantStyle,
  stripRetiredGeneralSettings,
  validatePatch
} from '../SettingsStore'

const baseSettings = () => createDefaultSettings('/models')

let userDataDir = ''
let encryptionAvailable = true

function readPersistedSettings(): AppSettings {
  return JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf-8')) as AppSettings
}

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir
  },
  // Fake, reversible "encryption" (base64) standing in for OS keychain/DPAPI —
  // real behaviour is Electron's, this only needs to be deterministic and
  // reversible so the store's own prefix/roundtrip logic can be tested.
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf-8')
  }
}))

describe('migrateLegacyAssistantStyle', () => {
  it('carries over a legacy ui.systemPrompt when the new field is empty', () => {
    const migrated = migrateLegacyAssistantStyle(baseSettings(), {
      ui: { systemPrompt: 'Be terse.' }
    })
    expect(migrated.assistantStyle.globalStyle).toBe('Be terse.')
  })

  it('does not overwrite an already-set assistantStyle.globalStyle', () => {
    const settings = { ...baseSettings(), assistantStyle: { globalStyle: 'Already set.' } }
    const migrated = migrateLegacyAssistantStyle(settings, { ui: { systemPrompt: 'Old value.' } })
    expect(migrated.assistantStyle.globalStyle).toBe('Already set.')
  })

  it('does nothing when there is no legacy value', () => {
    const settings = baseSettings()
    const migrated = migrateLegacyAssistantStyle(settings, {})
    expect(migrated).toBe(settings)
    expect(migrated.assistantStyle.globalStyle).toBe('')
  })

  it('ignores a legacy value that is only whitespace', () => {
    const migrated = migrateLegacyAssistantStyle(baseSettings(), { ui: { systemPrompt: '   ' } })
    expect(migrated.assistantStyle.globalStyle).toBe('')
  })

  it('truncates an overlong legacy value to the new cap', () => {
    const legacy = 'x'.repeat(MAX_ASSISTANT_STYLE_CHARS + 500)
    const migrated = migrateLegacyAssistantStyle(baseSettings(), { ui: { systemPrompt: legacy } })
    expect(migrated.assistantStyle.globalStyle.length).toBe(MAX_ASSISTANT_STYLE_CHARS)
  })

  it('strips the legacy field even when the new field already has content', () => {
    // Otherwise a later Reset of assistantStyle.globalStyle (which never
    // touches this stray field) would see it as "still legacy present, new
    // field now empty" on the next load and silently re-migrate the old text.
    const settings = { ...baseSettings(), assistantStyle: { globalStyle: 'Already set.' } }
    const migrated = migrateLegacyAssistantStyle(settings, { ui: { systemPrompt: 'Old value.' } })
    expect((migrated.ui as unknown as Record<string, unknown>).systemPrompt).toBeUndefined()
  })

  it('strips the legacy field even when it is only whitespace', () => {
    const migrated = migrateLegacyAssistantStyle(baseSettings(), { ui: { systemPrompt: '   ' } })
    expect((migrated.ui as unknown as Record<string, unknown>).systemPrompt).toBeUndefined()
  })
})

describe('stripRetiredGeneralSettings', () => {
  it('removes inactive General fields while preserving supported settings', () => {
    const result = stripRetiredGeneralSettings({
      general: {
        startupBehavior: 'reopen',
        projectFolder: '/projects',
        autoSave: true,
        permissionMode: 'ask'
      }
    })

    expect(result.changed).toBe(true)
    expect(result.settings.general).toEqual({ permissionMode: 'ask' })
  })

  it('leaves settings unchanged when retired fields are absent', () => {
    const settings = { general: { permissionMode: 'ask' } }
    const result = stripRetiredGeneralSettings(settings)

    expect(result.changed).toBe(false)
    expect(result.settings).toBe(settings)
  })
})

describe('validatePatch', () => {
  it('accepts an assistantStyle.globalStyle patch within the cap', () => {
    expect(() => validatePatch({ assistantStyle: { globalStyle: 'Be concise.' } })).not.toThrow()
  })

  it('rejects an assistantStyle.globalStyle patch over the documented cap', () => {
    const patch = { assistantStyle: { globalStyle: 'x'.repeat(MAX_ASSISTANT_STYLE_CHARS + 1) } }
    expect(() => validatePatch(patch)).toThrow(/assistantStyle.globalStyle/)
  })

  it('accepts supported sound themes and rejects unknown ones', () => {
    expect(() => validatePatch({ appearance: { soundTheme: 'sciFi' } })).not.toThrow()
    expect(() => validatePatch({ appearance: { soundTheme: 'orchestra' } } as never)).toThrow(
      /appearance.soundTheme/
    )
  })

  it('accepts sound volume from 0 to 100 and rejects out-of-range values', () => {
    expect(() => validatePatch({ appearance: { soundVolume: 0 } })).not.toThrow()
    expect(() => validatePatch({ appearance: { soundVolume: 100 } })).not.toThrow()
    expect(() => validatePatch({ appearance: { soundVolume: 101 } })).toThrow(
      /appearance.soundVolume/
    )
  })

  it('accepts a built-in tool opt-out list and rejects malformed entries', () => {
    expect(() => validatePatch({ tools: { disabledTools: ['run_command'] } })).not.toThrow()
    expect(() => validatePatch({ tools: { disabledTools: [''] } })).toThrow(/tools.disabledTools/)
    expect(() => validatePatch({ tools: { disabledTools: 'run_command' } } as never)).toThrow(
      /tools.disabledTools/
    )
  })
})

describe('SettingsStore.update validation', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'anodex-settings-'))
    encryptionAvailable = true
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('rejects an unknown top-level key', async () => {
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    expect(() => settingsStore.update({ notARealSetting: true } as never)).toThrow(
      /unknown settings key/i
    )
  })

  it('rejects an unknown nested key', async () => {
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    expect(() => settingsStore.update({ generation: { bogus: 1 } } as never)).toThrow(
      /unknown settings key/i
    )
  })

  it('still accepts a valid nested patch', async () => {
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    const next = settingsStore.update({ generation: { temperature: 0.5 } })
    expect(next.generation.temperature).toBe(0.5)
  })

  it('still accepts the "auto" / number union on model.gpuLayers', async () => {
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    expect(() => settingsStore.update({ model: { gpuLayers: 12 } })).not.toThrow()
    expect(() => settingsStore.update({ model: { gpuLayers: 'auto' } })).not.toThrow()
  })

  it('persists the selected sound theme and volume across sessions', async () => {
    const first = await import('../SettingsStore')
    first.settingsStore.init()
    first.settingsStore.update({ appearance: { soundTheme: 'sciFi', soundVolume: 35 } })

    vi.resetModules()
    const second = await import('../SettingsStore')
    second.settingsStore.init()
    expect(second.settingsStore.get().appearance.soundTheme).toBe('sciFi')
    expect(second.settingsStore.get().appearance.soundVolume).toBe(35)
  })
})

describe('SettingsStore API key encryption', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'anodex-settings-'))
    encryptionAvailable = true
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('stores API keys encrypted on disk but returns plaintext in memory', async () => {
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    const next = settingsStore.update({ provider: { anthropic: { apiKey: 'sk-ant-secret' } } })

    expect(next.provider.anthropic.apiKey).toBe('sk-ant-secret')

    const onDisk = readPersistedSettings()
    expect(onDisk.provider.anthropic.apiKey).not.toBe('sk-ant-secret')
    expect(onDisk.provider.anthropic.apiKey).toMatch(/^enc:/)
  })

  it('reads back a key encrypted by a prior session', async () => {
    const first = await import('../SettingsStore')
    first.settingsStore.init()
    first.settingsStore.update({ webSearch: { apiKey: 'brave-key' } })

    vi.resetModules()
    const second = await import('../SettingsStore')
    second.settingsStore.init()
    expect(second.settingsStore.get().webSearch.apiKey).toBe('brave-key')
  })

  it('treats legacy plaintext keys (pre-encryption settings.json) as still valid', async () => {
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    // Simulate an old settings.json written before this change, with a
    // plaintext key and no `enc:` prefix.
    settingsStore.update({ provider: { openai: { apiKey: 'legacy-plaintext-key' } } })
    const raw = readPersistedSettings()
    raw.provider.openai.apiKey = 'sk-legacy-unwrapped'
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify(raw, null, 2), 'utf-8')

    vi.resetModules()
    const reloaded = await import('../SettingsStore')
    reloaded.settingsStore.init()
    expect(reloaded.settingsStore.get().provider.openai.apiKey).toBe('sk-legacy-unwrapped')
  })

  it('falls back to plaintext when OS encryption is unavailable', async () => {
    encryptionAvailable = false
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    settingsStore.update({ provider: { anthropic: { apiKey: 'no-keychain-key' } } })

    const onDisk = readPersistedSettings()
    expect(onDisk.provider.anthropic.apiKey).toBe('no-keychain-key')
  })
})
