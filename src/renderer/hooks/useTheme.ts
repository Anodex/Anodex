import { useEffect } from 'react'
import type { AppearanceSettings } from '@shared/settings.types'
import { resolveThemeVariables, type ThemeVariables } from '../lib/themePresets'

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
function resolveIsDark(themeMode: AppearanceSettings['themeMode']): boolean {
  if (themeMode === 'dark') return true
  if (themeMode === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * Applies the user's appearance preferences to the document root.
 *
 * Presets and custom colours only ever style *dark* mode — light mode is
 * always the single, fixed, accessible palette defined in `global.css`'s
 * `[data-theme-mode='light']` block. This is a deliberate scope limit, not an
 * oversight: an inline `style.setProperty` on `<html>` always wins over a
 * stylesheet rule targeting the same element regardless of selector
 * specificity, so a dark-tuned preset color would otherwise leak through and
 * break light mode's contrast. Clearing every managed property whenever the
 * effective mode is light sidesteps that entirely.
 */
export function useTheme({ appearance }: UseThemeProps): void {
  useEffect(() => {
    if (!appearance) return

    const html = document.documentElement
    const body = document.body

    const applyColorMode = (): void => {
      const isDark = resolveIsDark(appearance.themeMode)
      html.setAttribute('data-theme-mode', appearance.themeMode)

      if (!isDark) {
        for (const name of MANAGED_VARIABLES) html.style.removeProperty(name)
        return
      }

      const variables = resolveThemeVariables(appearance)
      for (const name of MANAGED_VARIABLES) html.style.setProperty(name, variables[name])
    }

    applyColorMode()

    // 'system' mode needs to react live if the OS theme changes while open —
    // the light-mode CSS media query already does this for free, but the
    // preset/custom inline overrides above only run once per render otherwise.
    let mediaQuery: MediaQueryList | undefined
    if (appearance.themeMode === 'system') {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      mediaQuery.addEventListener('change', applyColorMode)
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

    return () => mediaQuery?.removeEventListener('change', applyColorMode)
  }, [appearance])
}
