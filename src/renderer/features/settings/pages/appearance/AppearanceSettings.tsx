import type { AppSettings } from '@shared/settings.types'
import { SettingRow } from '../../SettingRow'
import { SelectControl, ToggleControl } from '../../controls'
import pageStyles from '../../SettingsPage.module.css'
import styles from './AppearanceSettings.module.css'

interface AppearanceSettingsProps {
  settings: AppSettings
  update: (patch: Partial<AppSettings['appearance']>) => void
}

const PRESET_OPTIONS = [
  { label: 'Midnight', value: 'midnight' },
  { label: 'Slate', value: 'slate' },
  { label: 'Obsidian', value: 'obsidian' },
  { label: 'Custom', value: 'custom' }
]

const FONT_OPTIONS = [
  { label: 'System', value: 'system' },
  { label: 'Sans-serif', value: 'sans' },
  { label: 'Monospace', value: 'mono' }
]

const SIZE_OPTIONS = [
  { label: 'Small', value: 'small' },
  { label: 'Medium', value: 'medium' },
  { label: 'Large', value: 'large' }
]

const DENSITY_OPTIONS = [
  { label: 'Compact', value: 'compact' },
  { label: 'Comfortable', value: 'comfortable' }
]

const DIFF_VIEW_OPTIONS = [
  { label: 'Unified (all in one)', value: 'unified' },
  { label: 'Side by side', value: 'sideBySide' }
]

export function AppearanceSettings({ settings, update }: AppearanceSettingsProps): JSX.Element {
  const { appearance } = settings

  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.pageKicker}>Personal</p>
        <h1 className={pageStyles.pageTitle}>Appearance</h1>
        <p className={pageStyles.pageDesc}>Theme, typography, density, code views, and motion.</p>
      </header>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Theme</h2>
        <p className={pageStyles.sectionDesc}>Choose the look and feel of Anodex.</p>

        <div className={styles.modeGrid}>
          <ModeButton
            label="Dark"
            active={appearance.themeMode === 'dark'}
            onClick={() => update({ themeMode: 'dark' })}
          />
          <ModeButton
            label="Light"
            active={appearance.themeMode === 'light'}
            onClick={() => update({ themeMode: 'light' })}
          />
          <ModeButton
            label="System"
            active={appearance.themeMode === 'system'}
            onClick={() => update({ themeMode: 'system' })}
          />
        </div>

        <SettingRow
          label="Preset"
          description="Curated colour palettes for dark mode (light mode always uses its own fixed palette). Select Custom to edit individual colours."
          control={
            <SelectControl
              value={appearance.presetTheme}
              options={PRESET_OPTIONS}
              onChange={(value) => update({ presetTheme: value as typeof appearance.presetTheme })}
            />
          }
        />

        {appearance.presetTheme === 'custom' && (
          <div className={styles.colorGrid}>
            <ColorSwatch
              label="Primary"
              value={appearance.customTheme.primary}
              onChange={(value) =>
                update({ customTheme: { ...appearance.customTheme, primary: value } })
              }
            />
            <ColorSwatch
              label="Accent (hover)"
              value={appearance.customTheme.accent}
              onChange={(value) =>
                update({ customTheme: { ...appearance.customTheme, accent: value } })
              }
            />
            <ColorSwatch
              label="Background"
              value={appearance.customTheme.background}
              onChange={(value) =>
                update({ customTheme: { ...appearance.customTheme, background: value } })
              }
            />
            <ColorSwatch
              label="Surface"
              value={appearance.customTheme.surface}
              onChange={(value) =>
                update({ customTheme: { ...appearance.customTheme, surface: value } })
              }
            />
            <ColorSwatch
              label="Surface highlight"
              value={appearance.customTheme.surfaceHighlight}
              onChange={(value) =>
                update({ customTheme: { ...appearance.customTheme, surfaceHighlight: value } })
              }
            />
            <ColorSwatch
              label="Border"
              value={appearance.customTheme.border}
              onChange={(value) =>
                update({ customTheme: { ...appearance.customTheme, border: value } })
              }
            />
            <ColorSwatch
              label="Text"
              value={appearance.customTheme.text}
              onChange={(value) =>
                update({ customTheme: { ...appearance.customTheme, text: value } })
              }
            />
            <ColorSwatch
              label="Text (muted)"
              value={appearance.customTheme.textMuted}
              onChange={(value) =>
                update({ customTheme: { ...appearance.customTheme, textMuted: value } })
              }
            />
          </div>
        )}
      </section>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Typography & density</h2>
        <p className={pageStyles.sectionDesc}>Fine-tune readability and spacing.</p>
        <SettingRow
          label="Font"
          description="Preferred UI font family."
          control={
            <SelectControl
              value={appearance.font}
              options={FONT_OPTIONS}
              onChange={(value) => update({ font: value as typeof appearance.font })}
            />
          }
        />
        <SettingRow
          label="Font size"
          description="Global text size scale."
          control={
            <SelectControl
              value={appearance.fontSize}
              options={SIZE_OPTIONS}
              onChange={(value) => update({ fontSize: value as typeof appearance.fontSize })}
            />
          }
        />
        <SettingRow
          label="Density"
          description="Spacing between list items and panels."
          control={
            <SelectControl
              value={appearance.density}
              options={DENSITY_OPTIONS}
              onChange={(value) => update({ density: value as typeof appearance.density })}
            />
          }
        />
      </section>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Code & diffs</h2>
        <p className={pageStyles.sectionDesc}>How file changes render in the chat transcript.</p>
        <SettingRow
          label="Diff view"
          description="Unified shows one column with additions and removals inline. Side by side shows the old and new versions next to each other."
          control={
            <SelectControl
              value={appearance.diffView}
              options={DIFF_VIEW_OPTIONS}
              onChange={(value) => update({ diffView: value as typeof appearance.diffView })}
            />
          }
        />
      </section>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Motion & sound</h2>
        <SettingRow
          label="Sound effects"
          description="Play subtle sounds for completions and errors."
          control={
            <ToggleControl
              checked={appearance.soundEffects}
              onChange={(value) => update({ soundEffects: value })}
            />
          }
        />
        <SettingRow
          label="Reduced motion"
          description="Minimise animations and transitions."
          control={
            <ToggleControl
              checked={appearance.reducedMotion}
              onChange={(value) => update({ reducedMotion: value })}
            />
          }
        />
        <SettingRow
          label="Compact mode"
          description="Shrink the sidebar and header for smaller screens."
          control={
            <ToggleControl
              checked={appearance.compactMode}
              onChange={(value) => update({ compactMode: value })}
            />
          }
        />
      </section>
    </div>
  )
}

function ModeButton({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={`${styles.modeButton} ${active ? styles.modeButtonActive : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function ColorSwatch({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <label className={styles.colorSwatch}>
      <span className={styles.colorLabel}>{label}</span>
      <input
        type="color"
        className={styles.colorInput}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className={styles.colorValue}>{value}</span>
    </label>
  )
}
