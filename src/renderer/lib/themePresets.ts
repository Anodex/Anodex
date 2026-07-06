import type { AppearanceSettings } from '@shared/settings.types'

/** The CSS custom properties a preset or a custom theme controls. */
export interface ThemeVariables {
  '--bg-base': string
  '--bg-app': string
  '--bg-surface': string
  '--bg-surface-2': string
  '--bg-elevated': string
  '--bg-input': string
  '--border': string
  '--border-strong': string
  '--text': string
  '--text-muted': string
  '--accent': string
  '--accent-hover': string
}

/**
 * Named dark-mode palettes. `midnight` matches `theme.css`'s own `:root`
 * defaults exactly, so selecting it is equivalent to applying no override at
 * all — kept as an explicit entry anyway so the three presets are switched
 * through the same code path instead of `midnight` being a special case.
 */
export const THEME_PRESETS: Record<'midnight' | 'slate' | 'obsidian', ThemeVariables> = {
  midnight: {
    '--bg-base': '#080808',
    '--bg-app': '#0c0c0c',
    '--bg-surface': '#111111',
    '--bg-surface-2': '#161616',
    '--bg-elevated': '#1c1c1c',
    '--bg-input': '#0f0f0f',
    '--border': '#1f1f1f',
    '--border-strong': '#2a2a2a',
    '--text': '#f0f0f0',
    '--text-muted': '#a0a0a0',
    '--accent': '#4f8cff',
    '--accent-hover': '#3d7be8'
  },
  slate: {
    '--bg-base': '#0a0d12',
    '--bg-app': '#0d1117',
    '--bg-surface': '#12161d',
    '--bg-surface-2': '#171c25',
    '--bg-elevated': '#1d232e',
    '--bg-input': '#0f1319',
    '--border': '#232935',
    '--border-strong': '#2e3644',
    '--text': '#e8ebf0',
    '--text-muted': '#8b93a3',
    '--accent': '#5b9bd5',
    '--accent-hover': '#4a87c2'
  },
  obsidian: {
    '--bg-base': '#0a0808',
    '--bg-app': '#0d0b0b',
    '--bg-surface': '#141010',
    '--bg-surface-2': '#1a1414',
    '--bg-elevated': '#201919',
    '--bg-input': '#0f0c0c',
    '--border': '#2a2222',
    '--border-strong': '#362c2c',
    '--text': '#f0ece8',
    '--text-muted': '#a89e96',
    '--accent': '#7c5cff',
    '--accent-hover': '#6b4de6'
  }
}

/** Derives the same variable set from the user's custom colour picks. */
export function customThemeVariables(
  customTheme: AppearanceSettings['customTheme']
): ThemeVariables {
  return {
    '--bg-base': customTheme.background,
    '--bg-app': customTheme.background,
    '--bg-surface': customTheme.surface,
    '--bg-surface-2': customTheme.surfaceHighlight,
    '--bg-elevated': customTheme.surfaceHighlight,
    '--bg-input': customTheme.background,
    '--border': customTheme.border,
    '--border-strong': customTheme.border,
    '--text': customTheme.text,
    '--text-muted': customTheme.textMuted,
    '--accent': customTheme.primary,
    '--accent-hover': customTheme.accent
  }
}

/**
 * Resolves the palette a `presetTheme` selection should apply in dark mode.
 * Pure so it's unit-testable independent of the DOM-mutating effect that
 * consumes it.
 */
export function resolveThemeVariables(appearance: AppearanceSettings): ThemeVariables {
  if (appearance.presetTheme === 'custom') return customThemeVariables(appearance.customTheme)
  return THEME_PRESETS[appearance.presetTheme]
}
