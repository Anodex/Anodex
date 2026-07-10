import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/settings.types'

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
