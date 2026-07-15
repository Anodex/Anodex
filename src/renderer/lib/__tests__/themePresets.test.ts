import { describe, expect, it } from 'vitest'
import type { AppearanceSettings } from '@shared/settings.types'
import { customThemeVariables, resolveThemeVariables, THEME_PRESETS } from '../themePresets'

const customTheme: AppearanceSettings['customTheme'] = {
  primary: '#111111',
  accent: '#222222',
  background: '#333333',
  surface: '#444444',
  surfaceHighlight: '#555555',
  border: '#666666',
  text: '#777777',
  textMuted: '#888888'
}

function makeAppearance(overrides: Partial<AppearanceSettings>): AppearanceSettings {
  return {
    themeMode: 'dark',
    presetTheme: 'midnight',
    customTheme,
    font: 'system',
    fontSize: 'medium',
    density: 'comfortable',
    soundEffects: false,
    reducedMotion: false,
    compactMode: false,
    diffView: 'unified',
    chatBackground: 'deepField',
    ...overrides
  }
}

describe('customThemeVariables', () => {
  it('maps primary to --accent and accent to --accent-hover, not the reverse', () => {
    const vars = customThemeVariables(customTheme)
    expect(vars['--accent']).toBe(customTheme.primary)
    expect(vars['--accent-hover']).toBe(customTheme.accent)
  })

  it('derives bg-base and bg-input from background, and bg-elevated from surfaceHighlight', () => {
    const vars = customThemeVariables(customTheme)
    expect(vars['--bg-base']).toBe(customTheme.background)
    expect(vars['--bg-input']).toBe(customTheme.background)
    expect(vars['--bg-elevated']).toBe(customTheme.surfaceHighlight)
    expect(vars['--bg-surface-2']).toBe(customTheme.surfaceHighlight)
  })
})

describe('resolveThemeVariables', () => {
  it('returns the matching named preset for midnight/slate/obsidian', () => {
    expect(resolveThemeVariables(makeAppearance({ presetTheme: 'slate' }))).toEqual(
      THEME_PRESETS.slate
    )
    expect(resolveThemeVariables(makeAppearance({ presetTheme: 'obsidian' }))).toEqual(
      THEME_PRESETS.obsidian
    )
  })

  it('derives variables from customTheme when presetTheme is custom', () => {
    const result = resolveThemeVariables(makeAppearance({ presetTheme: 'custom' }))
    expect(result).toEqual(customThemeVariables(customTheme))
  })
})
