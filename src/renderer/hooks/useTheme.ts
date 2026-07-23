import { useEffect, useRef } from 'react'
import type { AppearanceSettings } from '@shared/settings.types'
import {
  basePresetOf,
  resolveThemeVariables,
  themeModeOf,
  type ThemeVariables
} from '../lib/themePresets'

interface UseThemeProps {
  appearance: AppearanceSettings | undefined
}

const FONT_FAMILIES: Record<AppearanceSettings['font'], string> = {
  system:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  sans: "'Inter', 'Helvetica Neue', Arial, sans-serif",
  mono: "'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', ui-monospace, monospace"
}

const FONT_SIZE_BASE: Record<AppearanceSettings['fontSize'], string> = {
  small: '12px',
  medium: '13px',
  large: '14px'
}

const MANAGED_VARIABLES: (keyof ThemeVariables)[] = [
  '--bg-base',
  '--bg-app',
  '--bg-surface',
  '--bg-surface-2',
  '--bg-elevated',
  '--bg-input',
  '--border',
  '--border-strong',
  '--text',
  '--text-muted',
  '--accent',
  '--accent-hover'
]

/** True if the effective mode (resolving 'system' via the OS preference) is dark. */
function resolveIsDark(theme: AppearanceSettings['theme']): boolean {
  const mode = themeModeOf(theme)
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * Applies the user's appearance preferences to the document root.
 *
 * There's no separate light/dark "mode" setting — `appearance.theme` is a
 * single flat choice ('midnight', 'midnightLight', 'slate', 'slateLight',
 * 'obsidian', 'system', or 'custom') and picking a different one is the only
 * way the look changes. Internally this still maps onto two mechanisms
 * though, kept as an implementation detail behind `themeModeOf`/
 * `basePresetOf` (`../lib/themePresets.ts`):
 *
 * - Dark themes (including 'system' when the OS is dark) apply as inline
 *   style overrides here.
 * - Light themes are handled entirely by CSS instead (`styles/themes/
 *   light.css`, `light-slate.css`), selected via the `data-theme-mode` /
 *   `data-preset-theme` attributes below — never inline overrides. This
 *   split is deliberate: an inline `style.setProperty` on `<html>` always
 *   wins over a stylesheet rule targeting the same element regardless of
 *   selector specificity, so a dark-tuned colour would leak through and
 *   break light mode's contrast if light mode used the same inline-override
 *   mechanism. Clearing every managed inline property whenever the
 *   effective mode is light sidesteps that entirely.
 */
export function useTheme({ appearance }: UseThemeProps): void {
  // The theme applied by the previous effect run. Lets a re-run tell a real
  // theme switch (dissolve-worthy) apart from the initial mount or an
  // unrelated appearance change (font, density, custom-colour tweaks).
  const appliedTheme = useRef<AppearanceSettings['theme'] | null>(null)

  useEffect(() => {
    if (!appearance) return

    const html = document.documentElement
    const body = document.body

    const applyColorMode = (): void => {
      const isDark = resolveIsDark(appearance.theme)
      html.setAttribute('data-theme-mode', themeModeOf(appearance.theme))
      // Dark presets apply via the inline overrides below; light presets
      // (see styles/themes/light-slate.css) select on this attribute instead,
      // since there's no light-mode stylesheet rule they need to out-rank.
      html.setAttribute('data-preset-theme', basePresetOf(appearance.theme))

      if (!isDark) {
        for (const name of MANAGED_VARIABLES) html.style.removeProperty(name)
        return
      }

      const variables = resolveThemeVariables(appearance)
      for (const name of MANAGED_VARIABLES) html.style.setProperty(name, variables[name])
    }

    // A genuine theme switch cross-dissolves the whole window (View
    // Transitions crossfade, paced in global.css). Everything else — initial
    // mount, font/density changes, custom-colour tweaks mid-drag — applies
    // directly, as does reduced motion or a missing API.
    const applyWithDissolve = (): void => {
      const dissolve =
        !appearance.reducedMotion && typeof document.startViewTransition === 'function'
      if (dissolve) document.startViewTransition(applyColorMode)
      else applyColorMode()
    }

    if (appliedTheme.current !== null && appliedTheme.current !== appearance.theme) {
      applyWithDissolve()
    } else {
      applyColorMode()
    }
    appliedTheme.current = appearance.theme

    // 'system' needs to react live if the OS theme changes while open — the
    // light-mode CSS media query already does this for free, but the
    // preset/custom inline overrides above only run once per render otherwise.
    // That flip is a real theme change, so it dissolves too.
    let mediaQuery: MediaQueryList | undefined
    if (appearance.theme === 'system') {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      mediaQuery.addEventListener('change', applyWithDissolve)
    }

    body.style.fontFamily = FONT_FAMILIES[appearance.font]
    body.style.fontSize = FONT_SIZE_BASE[appearance.fontSize]

    body.setAttribute('data-density', appearance.density)
    body.setAttribute('data-compact-mode', String(appearance.compactMode))

    if (appearance.reducedMotion) {
      body.setAttribute('data-reduced-motion', 'true')
    } else {
      body.removeAttribute('data-reduced-motion')
    }

    return () => mediaQuery?.removeEventListener('change', applyWithDissolve)
  }, [appearance])
}
