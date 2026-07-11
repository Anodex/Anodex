import { describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@shared/settings.defaults'
import { MAX_ASSISTANT_STYLE_CHARS } from '@shared/settings.types'
import { migrateLegacyAssistantStyle } from '../SettingsStore'

const baseSettings = () => createDefaultSettings('/models')

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
    const legacy = 'x'.repeat(2000)
    const migrated = migrateLegacyAssistantStyle(baseSettings(), { ui: { systemPrompt: legacy } })
    expect(migrated.assistantStyle.globalStyle.length).toBe(MAX_ASSISTANT_STYLE_CHARS)
  })
})
