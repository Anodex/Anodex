import type { AppearanceSettings } from '@shared/settings.types'
import type { ThemeVariables } from './themes/types'
import { midnightTheme } from './themes/midnight'
import { slateTheme } from './themes/slate'
import { obsidianTheme } from './themes/obsidian'

export type { ThemeVariables }
export type ThemeChoice = AppearanceSettings['theme']

/**
 * Named dark palettes, one file per theme under `./themes/`. Applied as
 * inline overrides by `../hooks/useTheme.ts` for every dark `ThemeChoice`
 * ('midnight', 'slate', 'obsidian', and 'system' when the OS is dark).
 *
 * To add a new one: create `./themes/<name>.ts` exporting a `ThemeVariables`
 * const (see `./themes/slate.ts` for the shape), import and add it below,
 * extend the `theme` union in `src/shared/settings.types.ts`, add it to
 * `basePresetOf`/`themeModeOf` below if it needs a light rendition too (see
 * `../styles/themes/light-slate.css` for that pattern), and add an option to
 * the theme dropdown in
 * `features/settings/pages/appearance/AppearanceSettings.tsx`.
 */
export const THEME_PRESETS: Record<'midnight' | 'slate' | 'obsidian', ThemeVariables> = {
  midnight: midnightTheme,
  slate: slateTheme,
  obsidian: obsidianTheme
}

/**
 * Whether a `ThemeChoice` renders dark or light. 'system' isn't resolvable
 * here — it depends on live OS state, so callers (`useTheme.ts`,
 * `ChatConstellation.tsx`, `ChatCircuit.tsx`) treat it as its own third case
 * and watch `prefers-color-scheme` themselves.
 */
export function themeModeOf(theme: ThemeChoice): 'dark' | 'light' | 'system' {
  if (theme === 'system') return 'system'
  if (theme === 'midnightLight' || theme === 'slateLight') return 'light'
  return 'dark'
}

/**
 * The base preset identity a `ThemeChoice` renders with. Drives both which
 * dark preset's inline overrides apply (`THEME_PRESETS[...]`, dark themes
 * only) and which light CSS palette wins via selector specificity (light
 * themes only — see `../styles/themes/light-slate.css`). 'custom' isn't a
 * real preset key; callers branch on it before consulting this. 'system'
 * always pairs with 'midnight', matching the one light/dark pair it's wired
 * to switch between.
 */
export function basePresetOf(theme: ThemeChoice): keyof typeof THEME_PRESETS {
  if (theme === 'slate' || theme === 'slateLight') return 'slate'
  if (theme === 'obsidian') return 'obsidian'
  return 'midnight'
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
 * Resolves the palette a dark `theme` selection should apply as inline
 * overrides. Only meaningful when `themeModeOf(appearance.theme)` (with
 * 'system' resolved against live OS state first) is 'dark' — light themes
 * are handled entirely by CSS instead, never inline overrides. Pure so it's
 * unit-testable independent of the DOM-mutating effect that consumes it.
 */
export function resolveThemeVariables(appearance: AppearanceSettings): ThemeVariables {
  if (appearance.theme === 'custom') return customThemeVariables(appearance.customTheme)
  return THEME_PRESETS[basePresetOf(appearance.theme)]
}
