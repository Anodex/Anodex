import type { ThemeVariables } from './types'

/**
 * Anodex's own dark palette, shown in Settings as "Anodex". Matches
 * `../../styles/themes/midnight.css`'s `:root` defaults exactly, so
 * selecting it is equivalent to applying no override at all — kept as an
 * explicit entry anyway so all presets are switched through the same code
 * path instead of this being a special case.
 */
export const midnightTheme: ThemeVariables = {
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
}
