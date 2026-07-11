import { describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@shared/settings.defaults'
import { MAX_ASSISTANT_STYLE_CHARS } from '@shared/settings.types'
import { migrateLegacyAssistantStyle, validatePatch } from '../SettingsStore'

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

describe('validatePatch', () => {
  it('accepts an assistantStyle.globalStyle patch within the cap', () => {
    expect(() => validatePatch({ assistantStyle: { globalStyle: 'Be concise.' } })).not.toThrow()
  })

  it('rejects an assistantStyle.globalStyle patch over the documented cap', () => {
    const patch = { assistantStyle: { globalStyle: 'x'.repeat(MAX_ASSISTANT_STYLE_CHARS + 1) } }
    expect(() => validatePatch(patch)).toThrow(/assistantStyle.globalStyle/)
  })
})
