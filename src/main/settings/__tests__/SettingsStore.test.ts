import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  migrateLegacyMaxTokens,
  migrateLegacyThemeMode,
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
    // whole patch, context size and token budget included.
    expect(() =>
      validatePatch({
        model: { contextSize: 16384, gpuLayers: 'auto', autoConfigured: true },
        generation: { maxTokens: 4096 }
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
      model: { contextSize: 16384, gpuLayers: 'auto', autoConfigured: true },
      generation: { maxTokens: 4096 }
    })

    vi.resetModules()
    const second = await import('../SettingsStore')
    second.settingsStore.init()
    // The flag has to survive a restart, or auto-config re-runs on every launch
    // and overwrites whatever the user set by hand in between.
    expect(second.settingsStore.get().model.autoConfigured).toBe(true)
    expect(second.settingsStore.get().model.contextSize).toBe(16384)
    expect(second.settingsStore.get().generation.maxTokens).toBe(4096)
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
