import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/settings.types'
import { MAX_ASSISTANT_STYLE_CHARS } from '@shared/settings.types'
import { createDefaultSettings } from '@shared/settings.defaults'
import {
  LEGACY_GMAIL_ACCOUNT_ID,
  migrateLegacyAssistantStyle,
  migrateLegacyGmailAccount,
  migrateLegacyContextReplay,
  migrateLegacyMaxTokens,
  migrateLegacyThemeMode,
  stripRetiredGeneralSettings,
  validatePatch
} from '../SettingsStore'

const baseSettings = () => createDefaultSettings('/models')

let userDataDir = ''
let encryptionAvailable = true
/** Stands in for a keyring that is present but refuses (locked, or a different user). */
let decryptionFails = false

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
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (buffer: Buffer) => {
      if (decryptionFails) throw new Error('The keyring is locked.')
      return buffer.toString('utf-8')
    }
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

describe('migrateLegacyThemeMode', () => {
  it('does nothing when there are no legacy fields', () => {
    const settings = baseSettings()
    const migrated = migrateLegacyThemeMode(settings, {})
    expect(migrated).toBe(settings)
    expect(migrated.appearance.theme).toBe('midnight')
  })

  it('maps dark + a named preset straight across', () => {
    const migrated = migrateLegacyThemeMode(baseSettings(), {
      appearance: { themeMode: 'dark', presetTheme: 'slate' }
    })
    expect(migrated.appearance.theme).toBe('slate')
  })

  it('maps dark + custom straight across', () => {
    const migrated = migrateLegacyThemeMode(baseSettings(), {
      appearance: { themeMode: 'dark', presetTheme: 'custom' }
    })
    expect(migrated.appearance.theme).toBe('custom')
  })

  it('maps light + midnight to midnightLight', () => {
    const migrated = migrateLegacyThemeMode(baseSettings(), {
      appearance: { themeMode: 'light', presetTheme: 'midnight' }
    })
    expect(migrated.appearance.theme).toBe('midnightLight')
  })

  it('maps light + slate to slateLight', () => {
    const migrated = migrateLegacyThemeMode(baseSettings(), {
      appearance: { themeMode: 'light', presetTheme: 'slate' }
    })
    expect(migrated.appearance.theme).toBe('slateLight')
  })

  it('maps light + obsidian to the default midnightLight (no Obsidian light variant)', () => {
    const migrated = migrateLegacyThemeMode(baseSettings(), {
      appearance: { themeMode: 'light', presetTheme: 'obsidian' }
    })
    expect(migrated.appearance.theme).toBe('midnightLight')
  })

  it('maps system to the flat system entry regardless of the old preset', () => {
    const migrated = migrateLegacyThemeMode(baseSettings(), {
      appearance: { themeMode: 'system', presetTheme: 'slate' }
    })
    expect(migrated.appearance.theme).toBe('system')
  })

  it('strips the legacy fields so they do not linger in appearance', () => {
    const migrated = migrateLegacyThemeMode(baseSettings(), {
      appearance: { themeMode: 'dark', presetTheme: 'obsidian' }
    })
    const appearance = migrated.appearance as unknown as Record<string, unknown>
    expect(appearance.themeMode).toBeUndefined()
    expect(appearance.presetTheme).toBeUndefined()
  })
})

describe('migrateLegacyGmailAccount', () => {
  const legacyGmail = (overrides: Record<string, unknown> = {}) => ({
    email: {
      provider: 'gmail',
      gmail: {
        enabled: true,
        address: 'person@gmail.com',
        oauthClientId: 'client-123',
        oauthClientSecret: 'secret-should-not-survive',
        syncMode: 'full',
        ...overrides
      }
    }
  })

  it('leaves settings alone when there is no legacy email block', () => {
    const settings = baseSettings()

    expect(migrateLegacyGmailAccount(settings, {})).toBe(settings)
  })

  it('turns a configured legacy Gmail account into the first linked account', () => {
    const migrated = migrateLegacyGmailAccount(baseSettings(), legacyGmail())

    expect(migrated.email.accounts).toHaveLength(1)
    expect(migrated.email.accounts[0]).toMatchObject({
      id: LEGACY_GMAIL_ACCOUNT_ID,
      provider: 'gmail',
      address: 'person@gmail.com',
      authKind: 'oauth',
      syncMode: 'full',
      oauthClientId: 'client-123'
    })
    expect(migrated.email.primaryAccountId).toBe(LEGACY_GMAIL_ACCOUNT_ID)
  })

  it('keeps the account id equal to the old token key so the token still resolves', () => {
    // EmailAuthStore used to key tokens by provider name. Reusing that string
    // as the account id is what avoids a separate token-store migration.
    const migrated = migrateLegacyGmailAccount(baseSettings(), legacyGmail())

    expect(migrated.email.accounts[0].id).toBe('gmail')
  })

  it('drops the plaintext client secret rather than carrying it forward', () => {
    const migrated = migrateLegacyGmailAccount(baseSettings(), legacyGmail())
    const account = migrated.email.accounts[0] as unknown as Record<string, unknown>

    expect(account.oauthClientSecret).toBeUndefined()
    expect(JSON.stringify(migrated)).not.toContain('secret-should-not-survive')
  })

  it('strips the retired provider and gmail keys so the migration runs once', () => {
    const migrated = migrateLegacyGmailAccount(baseSettings(), legacyGmail())
    const email = migrated.email as unknown as Record<string, unknown>

    expect(email.provider).toBeUndefined()
    expect(email.gmail).toBeUndefined()
  })

  it('creates no account when Gmail was never configured', () => {
    const migrated = migrateLegacyGmailAccount(baseSettings(), {
      email: { provider: 'none', gmail: { enabled: false, address: '', oauthClientId: '' } }
    })

    expect(migrated.email.accounts).toEqual([])
    expect(migrated.email.primaryAccountId).toBeNull()
  })

  it('migrates an account that was configured but left disabled', () => {
    const migrated = migrateLegacyGmailAccount(
      baseSettings(),
      legacyGmail({ enabled: false, oauthClientId: '' })
    )

    expect(migrated.email.accounts).toHaveLength(1)
    expect(migrated.email.accounts[0].address).toBe('person@gmail.com')
  })

  it('never overwrites accounts that already exist', () => {
    const settings = baseSettings()
    settings.email.accounts = [
      {
        id: 'existing',
        provider: 'imap',
        address: 'person@fastmail.com',
        displayName: 'person@fastmail.com',
        authKind: 'password',
        syncMode: 'metadata',
        createdAt: 1
      }
    ]

    const migrated = migrateLegacyGmailAccount(settings, legacyGmail())

    expect(migrated.email.accounts).toHaveLength(1)
    expect(migrated.email.accounts[0].id).toBe('existing')
  })
})

describe('stripRetiredGeneralSettings', () => {
  it('removes inactive General fields while preserving supported settings', () => {
    const result = stripRetiredGeneralSettings({
      general: {
        startupBehavior: 'reopen',
        projectFolder: '/projects',
        autoSave: true,
        defaultWorkspace: '/old/workspace',
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

  it('accepts dynamic model-to-projector path mappings', () => {
    expect(() =>
      validatePatch({
        visionProjectorPaths: {
          'C:\\models\\qwen.gguf': 'C:\\models\\mmproj-F16.gguf'
        }
      })
    ).not.toThrow()
  })

  it('rejects empty vision projector mapping values', () => {
    expect(() =>
      validatePatch({
        visionProjectorPaths: {
          'C:\\models\\qwen.gguf': ''
        }
      })
    ).toThrow(/visionProjectorPaths/)
  })

  it('allows disabling the per-turn time limit, but bounds it when set', () => {
    expect(() => validatePatch({ generation: { turnTimeLimitMinutes: null } })).not.toThrow()
    expect(() => validatePatch({ generation: { turnTimeLimitMinutes: 5 } })).not.toThrow()
    expect(() => validatePatch({ generation: { turnTimeLimitMinutes: 0 } })).toThrow(
      /turnTimeLimitMinutes/
    )
    expect(() => validatePatch({ generation: { turnTimeLimitMinutes: 300 } })).toThrow(
      /turnTimeLimitMinutes/
    )
  })

  it('accepts null and in-range fractions for the local replay cap', () => {
    expect(() =>
      validatePatch({ provider: { local: { recallWindowFraction: null } } })
    ).not.toThrow()
    expect(() =>
      validatePatch({ provider: { local: { recallWindowFraction: 0.4 } } })
    ).not.toThrow()
    expect(() =>
      validatePatch({ provider: { local: { recallWindowFraction: 0.01 } } })
    ).not.toThrow()
  })

  it('rejects out-of-range or malformed local replay caps', () => {
    expect(() => validatePatch({ provider: { local: { recallWindowFraction: 0 } } })).toThrow(
      /recallWindowFraction/
    )
    expect(() => validatePatch({ provider: { local: { recallWindowFraction: 1 } } })).toThrow(
      /recallWindowFraction/
    )
    expect(() => validatePatch({ provider: { local: { recallWindowFraction: -0.2 } } })).toThrow(
      /recallWindowFraction/
    )
    expect(() => validatePatch({ provider: { local: { recallWindowFraction: 2 } } })).toThrow(
      /recallWindowFraction/
    )
  })

  it('accepts null as the vision projector removal sentinel', () => {
    expect(() =>
      validatePatch({ visionProjectorPaths: { 'C:\\models\\qwen.gguf': null } })
    ).not.toThrow()
  })

  it('accepts a lastModelPath string or the null removal sentinel, but not empty', () => {
    expect(() => validatePatch({ lastModelPath: 'C:\\models\\qwen.gguf' })).not.toThrow()
    expect(() => validatePatch({ lastModelPath: null })).not.toThrow()
    expect(() => validatePatch({ lastModelPath: '  ' })).toThrow(/lastModelPath/)
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

  it('accepts the model.autoConfigured flag the hardware auto-config writes', () => {
    // `assertKnownKeys` derives its allow-list from `createDefaultSettings`, so
    // an optional field left out of the defaults is rejected here even though
    // `ModelSettings` declares it. That is how this flag silently stopped
    // persisting: every launch logged "Unknown settings key" and threw away the
    // whole patch, context size and GPU offload included.
    expect(() =>
      validatePatch({
        model: { contextSize: 16384, gpuLayers: 'auto', autoConfigured: true }
      })
    ).not.toThrow()
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
    decryptionFails = false
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

  it('starts a fresh install with model.autoConfigured explicitly false', async () => {
    // Not merely absent: the startup sequence checks `=== false` to tell a
    // never-configured install apart from settings that have not loaded yet.
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    expect(settingsStore.get().model.autoConfigured).toBe(false)
  })

  it('persists the hardware auto-config patch across sessions', async () => {
    const first = await import('../SettingsStore')
    first.settingsStore.init()
    first.settingsStore.update({
      model: { contextSize: 16384, gpuLayers: 'auto', autoConfigured: true }
    })

    vi.resetModules()
    const second = await import('../SettingsStore')
    second.settingsStore.init()
    // The flag has to survive a restart, or auto-config re-runs on every launch
    // and overwrites whatever the user set by hand in between.
    expect(second.settingsStore.get().model.autoConfigured).toBe(true)
    expect(second.settingsStore.get().model.contextSize).toBe(16384)
    expect(second.settingsStore.get().model.gpuLayers).toBe('auto')
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

describe('SettingsStore.update key removal', () => {
  const modelPath = 'C:\\models\\qwen.gguf'
  const otherPath = 'C:\\models\\llava.gguf'

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'anodex-settings-'))
    encryptionAvailable = true
    decryptionFails = false
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('removes a vision projector entry when patched with null', async () => {
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    settingsStore.update({
      visionProjectorPaths: { [modelPath]: 'C:\\models\\mmproj.gguf' }
    })

    const next = settingsStore.update({ visionProjectorPaths: { [modelPath]: null } })

    expect(modelPath in next.visionProjectorPaths).toBe(false)
    expect(modelPath in readPersistedSettings().visionProjectorPaths).toBe(false)
  })

  it('leaves the other entries of an open record untouched', async () => {
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    settingsStore.update({
      visionProjectorPaths: {
        [modelPath]: 'C:\\models\\mmproj.gguf',
        [otherPath]: 'C:\\models\\llava-mmproj.gguf'
      }
    })

    const next = settingsStore.update({ visionProjectorPaths: { [modelPath]: null } })

    expect(next.visionProjectorPaths).toEqual({ [otherPath]: 'C:\\models\\llava-mmproj.gguf' })
  })

  it('does not resurrect a removed entry on the next load', async () => {
    const first = await import('../SettingsStore')
    first.settingsStore.init()
    first.settingsStore.update({ visionProjectorPaths: { [modelPath]: 'C:\\models\\mmproj.gguf' } })
    first.settingsStore.update({ visionProjectorPaths: { [modelPath]: null } })

    vi.resetModules()
    const second = await import('../SettingsStore')
    second.settingsStore.init()
    expect(second.settingsStore.get().visionProjectorPaths).toEqual({})
  })

  it('clears lastModelPath when patched with null', async () => {
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    settingsStore.update({ lastModelPath: modelPath })

    expect(settingsStore.update({ lastModelPath: null }).lastModelPath).toBeUndefined()
  })

  it('ignores an undefined value rather than treating it as a removal', async () => {
    // `undefined` cannot survive JSON over IPC, so it is not the sentinel — a
    // caller reaching for it is the bug this behaviour is meant to expose.
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    settingsStore.update({ lastModelPath: modelPath })

    expect(settingsStore.update({ lastModelPath: undefined }).lastModelPath).toBe(modelPath)
  })

  it('stores a real null for settings that are not removable', async () => {
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    settingsStore.update({ workspace: { root: 'C:\\projects\\anodex' } })

    const next = settingsStore.update({ workspace: { root: null } })

    expect('root' in next.workspace).toBe(true)
    expect(next.workspace.root).toBeNull()
  })
})

describe('SettingsStore API key encryption', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'anodex-settings-'))
    encryptionAvailable = true
    decryptionFails = false
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

describe('migrateLegacyMaxTokens', () => {
  it('moves the retired global ceiling onto every cloud provider', () => {
    const migrated = migrateLegacyMaxTokens(baseSettings(), { generation: { maxTokens: 8192 } })

    expect(migrated.provider.anthropic.maxResponseTokens).toBe(8192)
    expect(migrated.provider.openai.maxResponseTokens).toBe(8192)
    expect(migrated.provider.azure.maxResponseTokens).toBe(8192)
    expect(migrated.provider.qwen.maxResponseTokens).toBe(8192)
  })

  it('leaves the local engine off, whatever the old global was', () => {
    // The whole point of the move: locally this number could only lower a
    // ceiling the engine already measures, and a low one loses entire turns
    // to tool calls cut off mid-arguments.
    const migrated = migrateLegacyMaxTokens(baseSettings(), { generation: { maxTokens: 2048 } })

    expect(migrated.provider.local.maxResponseTokens).toBeNull()
  })

  it('strips the retired key so it cannot be reapplied on a later load', () => {
    const migrated = migrateLegacyMaxTokens(baseSettings(), { generation: { maxTokens: 8192 } })

    expect('maxTokens' in migrated.generation).toBe(false)
  })

  it('never overwrites a ceiling the user already set for a provider', () => {
    const settings = baseSettings()
    settings.provider.openai.maxResponseTokens = 512

    const migrated = migrateLegacyMaxTokens(settings, { generation: { maxTokens: 8192 } })

    expect(migrated.provider.openai.maxResponseTokens).toBe(512)
    expect(migrated.provider.anthropic.maxResponseTokens).toBe(8192)
  })

  it('does nothing for a settings file that never had the old key', () => {
    const migrated = migrateLegacyMaxTokens(baseSettings(), {})

    expect(migrated.provider.anthropic.maxResponseTokens).toBeNull()
    expect(migrated.provider.local.maxResponseTokens).toBeNull()
  })
})

describe('migrateLegacyContextReplay', () => {
  it('moves the retired greedy default to balanced recall', () => {
    const migrated = migrateLegacyContextReplay(baseSettings(), {
      provider: { local: { replayCapFraction: null } }
    })

    expect(migrated.provider.local.recallWindowFraction).toBe(0.4)
  })

  it('retains an explicitly configured bounded fraction for continuity', () => {
    const migrated = migrateLegacyContextReplay(baseSettings(), {
      provider: { local: { replayCapFraction: 0.25 } }
    })

    expect(migrated.provider.local.recallWindowFraction).toBe(0.25)
  })

  it('does not change settings that never used the retired field', () => {
    const settings = baseSettings()
    expect(migrateLegacyContextReplay(settings, {})).toBe(settings)
  })
})

describe('SettingsStore — switching to a cloud provider', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'anodex-settings-'))
    encryptionAvailable = true
    decryptionFails = false
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  // `ProviderSettings.active` is a union of twelve, every one of which the
  // Provider Connections panel offers with `available: true` and a "Use for
  // chat" button that patches exactly this field.
  it('accepts every provider the settings type allows as the active one', () => {
    const active: Array<AppSettings['provider']['active']> = [
      'local',
      'anthropic',
      'openai',
      'google',
      'xai',
      'deepseek',
      'mistral',
      'groq',
      'openrouter',
      'azure',
      'kimi',
      'qwen'
    ]
    for (const id of active) {
      expect(() => validatePatch({ provider: { active: id } })).not.toThrow()
    }
  })

  it('still rejects a provider that does not exist', () => {
    expect(() => validatePatch({ provider: { active: 'nope' } } as never)).toThrow(
      /provider\.active/
    )
  })

  it('persists the switch, so the choice survives a restart', async () => {
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    settingsStore.update({ provider: { active: 'openrouter' } })
    expect(readPersistedSettings().provider.active).toBe('openrouter')
  })
})

describe('SettingsStore — a settings file that cannot be read', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'anodex-settings-'))
    encryptionAvailable = true
    decryptionFails = false
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('keeps the unreadable file instead of overwriting it with defaults', async () => {
    // This file holds every API key and every linked mail account. Falling back
    // to defaults is right — the app has to start — but the next save used to
    // write those defaults straight over the only copy, with nothing to recover
    // from and only a log line to say so.
    const path = join(userDataDir, 'settings.json')
    writeFileSync(path, '{"provider": {"anthropic": {"apiKey": "sk-live-key"', 'utf-8')

    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    settingsStore.update({ generation: { temperature: 0.5 } })

    expect(readFileSync(`${path}.corrupt`, 'utf-8')).toContain('sk-live-key')
  })

  it('still starts from defaults so the app is usable', async () => {
    writeFileSync(join(userDataDir, 'settings.json'), 'not json at all', 'utf-8')

    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()

    expect(settingsStore.get().provider.active).toBe('local')
  })
})

describe('SettingsStore — a migration running over encrypted keys', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'anodex-settings-'))
    encryptionAvailable = true
    decryptionFails = false
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  /** A settings file with a stored key and a retired field that forces a migration write. */
  function writeUpgradeableSettings(): void {
    const stored = {
      ...baseSettings(),
      general: { autoSave: true },
      provider: {
        ...baseSettings().provider,
        anthropic: {
          ...baseSettings().provider.anthropic,
          apiKey: `enc:${Buffer.from('sk-real-key', 'utf-8').toString('base64')}`
        }
      }
    }
    writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify(stored), 'utf-8')
  }

  // Passes against the pre-fix file: the session that performs the migration
  // decrypts the copy it already holds, so it never sees the damage it just
  // wrote. Kept as the other half of the pair below, which is where it shows.
  it('reads the key correctly in the session that migrates', async () => {
    writeUpgradeableSettings()

    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()

    expect(settingsStore.get().provider.anthropic.apiKey).toBe('sk-real-key')
  })

  it('leaves the key usable on the next launch, not just this one', async () => {
    // The migration write happens before decryption, so it was handed the
    // ciphertext read off disk and encrypted it again. One `decryptSecret` on
    // the way back out strips one layer only, so the next launch loads `enc:…`
    // as the API key and every request to that provider fails to authenticate.
    writeUpgradeableSettings()

    const first = await import('../SettingsStore')
    first.settingsStore.init()

    vi.resetModules()
    const second = await import('../SettingsStore')
    second.settingsStore.init()

    expect(second.settingsStore.get().provider.anthropic.apiKey).toBe('sk-real-key')
  })
})

describe('validatePatch — a block replaced by the wrong kind of value', () => {
  it('rejects a settings block sent as a scalar', () => {
    // `deepMerge` only recurses when both sides are objects, so this would be
    // taken wholesale and persisted, leaving `settings.provider` a string and
    // every later read of it throwing — across restarts.
    expect(() => validatePatch({ provider: 'anthropic' } as never)).toThrow(/must be an object/)
  })

  it('rejects a settings block sent as an array', () => {
    expect(() => validatePatch({ generation: [] } as never)).toThrow(/must be an object/)
  })

  it('still accepts the block sent properly', () => {
    expect(() => validatePatch({ provider: { active: 'anthropic' } })).not.toThrow()
  })
})

describe('SettingsStore — every provider key is encrypted at rest', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'anodex-settings-'))
    encryptionAvailable = true
    decryptionFails = false
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  /** Every provider that carries a key of its own — `local` has none. */
  const keyedProviders = Object.keys(baseSettings().provider).filter(
    (id) => id !== 'active' && id !== 'local'
  )

  it('covers all of them, not just the three that were named', async () => {
    // Google, xAI, DeepSeek, Mistral, Groq, OpenRouter, Azure, Kimi and Qwen
    // were added after the encryption was written and never added to it, so
    // their keys sat in settings.json in the clear.
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    for (const id of keyedProviders) {
      settingsStore.update({ provider: { [id]: { apiKey: `sk-${id}-secret` } } })
    }

    const onDisk = readPersistedSettings()
    for (const id of keyedProviders) {
      const stored = (onDisk.provider as unknown as Record<string, { apiKey: string }>)[id].apiKey
      expect(stored, id).toMatch(/^enc:/)
      expect(stored, id).not.toContain('secret')
    }
  })

  it('hands the plaintext back in memory, for every provider', async () => {
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    settingsStore.update({ provider: { openrouter: { apiKey: 'sk-or-live' } } })

    expect(settingsStore.get().provider.openrouter.apiKey).toBe('sk-or-live')
  })

  it('still encrypts the web-search key', async () => {
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    settingsStore.update({ webSearch: { apiKey: 'brave-secret' } })

    expect(readPersistedSettings().webSearch.apiKey).toMatch(/^enc:/)
    expect(settingsStore.get().webSearch.apiKey).toBe('brave-secret')
  })

  it('leaves a key alone where the OS offers no protection', async () => {
    // Some Linux sessions have no keyring. Storing plaintext is the honest
    // outcome; claiming an `enc:` prefix for something unprotected is not.
    encryptionAvailable = false
    const { settingsStore } = await import('../SettingsStore')
    settingsStore.init()
    settingsStore.update({ provider: { groq: { apiKey: 'sk-groq-live' } } })

    expect(readPersistedSettings().provider.groq.apiKey).toBe('sk-groq-live')
    expect(settingsStore.get().provider.groq.apiKey).toBe('sk-groq-live')
  })
})

describe('SettingsStore — a keyring that is unavailable this session', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'anodex-settings-'))
    encryptionAvailable = true
    decryptionFails = false
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('does not destroy the stored keys when it cannot read them', async () => {
    // A locked or late-starting keyring makes every key read as empty. Writing
    // that emptiness back over the ciphertext turns a temporary problem into a
    // permanent one — and with every provider now encrypted, it would take all
    // of them at once.
    const first = await import('../SettingsStore')
    first.settingsStore.init()
    first.settingsStore.update({ provider: { anthropic: { apiKey: 'sk-ant-live' } } })
    const stored = readPersistedSettings().provider.anthropic.apiKey

    vi.resetModules()
    decryptionFails = true
    const second = await import('../SettingsStore')
    second.settingsStore.init()
    expect(second.settingsStore.get().provider.anthropic.apiKey).toBe('')

    // Any unrelated settings change rewrites the whole file.
    second.settingsStore.update({ generation: { temperature: 0.5 } })

    expect(readPersistedSettings().provider.anthropic.apiKey).toBe(stored)
  })

  it('reads the key again once the keyring comes back', async () => {
    const first = await import('../SettingsStore')
    first.settingsStore.init()
    first.settingsStore.update({ provider: { anthropic: { apiKey: 'sk-ant-live' } } })

    vi.resetModules()
    decryptionFails = true
    const second = await import('../SettingsStore')
    second.settingsStore.init()
    second.settingsStore.update({ generation: { temperature: 0.5 } })

    vi.resetModules()
    decryptionFails = false
    const third = await import('../SettingsStore')
    third.settingsStore.init()

    expect(third.settingsStore.get().provider.anthropic.apiKey).toBe('sk-ant-live')
  })

  it('still lets a key be replaced by hand while the keyring is down', async () => {
    // Preserving the old ciphertext must not stop the user entering a new key.
    const first = await import('../SettingsStore')
    first.settingsStore.init()
    first.settingsStore.update({ provider: { anthropic: { apiKey: 'sk-old' } } })

    vi.resetModules()
    decryptionFails = true
    const second = await import('../SettingsStore')
    second.settingsStore.init()
    second.settingsStore.update({ provider: { anthropic: { apiKey: 'sk-new' } } })

    expect(second.settingsStore.get().provider.anthropic.apiKey).toBe('sk-new')
  })
})
