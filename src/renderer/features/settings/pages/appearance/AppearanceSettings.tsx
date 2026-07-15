import type { AppSettings } from '@shared/settings.types'
import { playInterfaceSound, previewSoundTheme, previewSoundVolume } from '../../../../lib/sound'
import { SettingRow } from '../../SettingRow'
import { RangeControl, SelectControl, ToggleControl } from '../../controls'
import pageStyles from '../../SettingsPage.module.css'
import styles from './AppearanceSettings.module.css'

interface AppearanceSettingsProps {
  settings: AppSettings
  update: (patch: Partial<AppSettings['appearance']>) => void
}

const THEME_OPTIONS = [
  { label: 'Anodex', value: 'dark:midnight' },
  { label: 'Slate', value: 'dark:slate' },
  { label: 'Obsidian', value: 'dark:obsidian' },
  { label: 'Anodex Light', value: 'light:midnight' },
  { label: 'Follow system', value: 'system:midnight' },
  { label: 'Custom colors', value: 'dark:custom' }
]

const CHAT_BACKGROUND_OPTIONS = [
  { label: 'Deep field (constellation)', value: 'deepField' },
  { label: 'Silicon bloom (circuit board)', value: 'siliconBloom' }
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

const SOUND_THEME_OPTIONS = [
  { label: 'Soft — warm and subtle', value: 'soft' },
  { label: 'Crisp — short and precise', value: 'crisp' },
  { label: 'Glass — airy and melodic', value: 'glass' },
  { label: 'Retro — quiet 8-bit cues', value: 'retro' },
  { label: 'Sci-fi pulse — rising electronic cue', value: 'sciFi' }
]

const DEFAULT_SOUND_VOLUME = 70

export function AppearanceSettings({ settings, update }: AppearanceSettingsProps): JSX.Element {
  const { appearance } = settings
  // A renderer hot-reload can briefly retain a settings object created before
  // soundVolume existed. The main-process defaults migrate it on a full load;
  // this fallback keeps the live Settings UI valid in the meantime.
  const soundVolume = appearance.soundVolume ?? DEFAULT_SOUND_VOLUME
  const selectedTheme =
    appearance.themeMode === 'dark'
      ? `dark:${appearance.presetTheme}`
      : `${appearance.themeMode}:midnight`

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

        <SettingRow
          label="Theme"
          description="Anodex is the default. Dark, light, adaptive, and custom themes share one list so new palettes can be added without changing the layout."
          control={
            <SelectControl
              value={selectedTheme}
              options={THEME_OPTIONS}
              onChange={(value) => {
                const [themeMode, presetTheme] = value.split(':') as [
                  typeof appearance.themeMode,
                  typeof appearance.presetTheme
                ]
                update({ themeMode, presetTheme })
              }}
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

        <SettingRow
          label="Chat background"
          description="Animated scene behind an empty chat. Deep field is a drifting 3D constellation; Silicon bloom is a living circuit board that etches itself. Both follow the theme and respect reduced motion."
          control={
            <SelectControl
              value={appearance.chatBackground}
              options={CHAT_BACKGROUND_OPTIONS}
              onChange={(value) =>
                update({ chatBackground: value as typeof appearance.chatBackground })
              }
            />
          }
        />
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
          description="Play subtle feedback for clicks, navigation, completions, approvals, and errors."
          control={
            <ToggleControl
              checked={appearance.soundEffects}
              onChange={(value) => {
                update({ soundEffects: value })
                if (value) {
                  playInterfaceSound('toggle', {
                    preview: true,
                    theme: appearance.soundTheme,
                    volume: soundVolume
                  })
                }
              }}
            />
          }
        />
        {appearance.soundEffects && (
          <SettingRow
            label="Sound style"
            description="Choose a sound palette. Selecting one plays a short preview."
            control={
              <SelectControl
                value={appearance.soundTheme}
                options={SOUND_THEME_OPTIONS}
                onChange={(value) => {
                  const soundTheme = value as typeof appearance.soundTheme
                  update({ soundTheme })
                  previewSoundTheme(soundTheme)
                }}
              />
            }
          />
        )}
        {appearance.soundEffects && (
          <SettingRow
            label="Sound volume"
            description="Adjust the level of interface feedback and status chimes."
            control={
              <RangeControl
                value={soundVolume}
                min={0}
                max={100}
                step={5}
                format={(value) => `${value}%`}
                onChange={(soundVolume) => {
                  update({ soundVolume })
                  previewSoundVolume(appearance.soundTheme, soundVolume)
                }}
              />
            }
          />
        )}
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
