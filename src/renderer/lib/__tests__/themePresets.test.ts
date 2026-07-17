import { describe, expect, it } from 'vitest'
import type { AppearanceSettings } from '@shared/settings.types'
import {
  basePresetOf,
  customThemeVariables,
  resolveThemeVariables,
  themeModeOf,
  THEME_PRESETS
} from '../themePresets'

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
    theme: 'midnight',
    customTheme,
    font: 'system',
    fontSize: 'medium',
    density: 'comfortable',
    soundEffects: false,
    soundTheme: 'soft',
    soundVolume: 70,
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

describe('themeModeOf', () => {
  it('treats midnight/slate/obsidian/custom as dark', () => {
    expect(themeModeOf('midnight')).toBe('dark')
    expect(themeModeOf('slate')).toBe('dark')
    expect(themeModeOf('obsidian')).toBe('dark')
    expect(themeModeOf('custom')).toBe('dark')
  })

  it('treats the Light variants as light', () => {
    expect(themeModeOf('midnightLight')).toBe('light')
    expect(themeModeOf('slateLight')).toBe('light')
  })

  it('treats system as its own case', () => {
    expect(themeModeOf('system')).toBe('system')
  })
})

describe('basePresetOf', () => {
  it('pairs each theme with its base preset', () => {
    expect(basePresetOf('midnight')).toBe('midnight')
    expect(basePresetOf('midnightLight')).toBe('midnight')
    expect(basePresetOf('slate')).toBe('slate')
    expect(basePresetOf('slateLight')).toBe('slate')
    expect(basePresetOf('obsidian')).toBe('obsidian')
  })

  it('pairs system with midnight, the one theme it switches between', () => {
    expect(basePresetOf('system')).toBe('midnight')
  })
})

describe('resolveThemeVariables', () => {
  it('returns the matching named preset for midnight/slate/obsidian', () => {
    expect(resolveThemeVariables(makeAppearance({ theme: 'slate' }))).toEqual(THEME_PRESETS.slate)
    expect(resolveThemeVariables(makeAppearance({ theme: 'obsidian' }))).toEqual(
      THEME_PRESETS.obsidian
    )
  })

  it('resolves system to the midnight preset (its dark pairing)', () => {
    expect(resolveThemeVariables(makeAppearance({ theme: 'system' }))).toEqual(
      THEME_PRESETS.midnight
    )
  })

  it('derives variables from customTheme when theme is custom', () => {
    const result = resolveThemeVariables(makeAppearance({ theme: 'custom' }))
    expect(result).toEqual(customThemeVariables(customTheme))
  })
})
