import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  KEYBOARD_SHORTCUT_DEFINITIONS,
  isBindableShortcut,
  shortcutFromEvent
} from '@shared/keyboardShortcuts'
import type { AppSettings, KeyboardShortcutId, KeyboardShortcutMap } from '@shared/settings.types'
import { Button } from '../../../../components/ui/Button'
import { ShortcutKeys } from '../../../../components/ShortcutKeys'
import pageStyles from '../../SettingsPage.module.css'
import styles from './KeyboardSettings.module.css'

interface KeyboardSettingsProps {
  settings: AppSettings
  update: (patch: Partial<AppSettings['keyboard']>) => void
}

export function KeyboardSettings({ settings, update }: KeyboardSettingsProps): JSX.Element {
  const shortcuts = settings.keyboard?.shortcuts ?? DEFAULT_KEYBOARD_SHORTCUTS
  const [recordingId, setRecordingId] = useState<KeyboardShortcutId | null>(null)
  const [status, setStatus] = useState<{ kind: 'info' | 'error'; message: string } | null>(null)

  const definitionsByCategory = useMemo(
    () =>
      KEYBOARD_SHORTCUT_DEFINITIONS.reduce(
        (groups, definition) => {
          groups[definition.category] = [...(groups[definition.category] ?? []), definition]
          return groups
        },
        {} as Record<string, typeof KEYBOARD_SHORTCUT_DEFINITIONS>
      ),
    []
  )

  const saveShortcut = (id: KeyboardShortcutId, shortcut: string): void => {
    const conflict = findConflict(id, shortcut, shortcuts)
    if (conflict) {
      setStatus({
        kind: 'error',
        message: `${shortcut} is already assigned to ${labelForShortcut(conflict)}.`
      })
      return
    }
    update({ shortcuts: { ...shortcuts, [id]: shortcut } })
    setStatus(
      shortcut
        ? { kind: 'info', message: `${labelForShortcut(id)} set to ${shortcut}.` }
        : { kind: 'info', message: `${labelForShortcut(id)} disabled.` }
    )
  }

  const handleCapture = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    id: KeyboardShortcutId
  ): void => {
    if (recordingId !== id) return
    event.preventDefault()
    event.stopPropagation()

    if (event.key === 'Escape') {
      setRecordingId(null)
      setStatus({ kind: 'info', message: 'Shortcut recording cancelled.' })
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      saveShortcut(id, '')
      setRecordingId(null)
      return
    }

    const shortcut = shortcutFromEvent(event.nativeEvent)
    if (!shortcut || !isBindableShortcut(shortcut)) {
      setStatus({
        kind: 'error',
        message: 'Add a Ctrl, Alt, or Windows key — a bare letter would block normal typing.'
      })
      return
    }

    saveShortcut(id, shortcut)
    setRecordingId(null)
  }

  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.pageKicker}>Personal</p>
        <h1 className={pageStyles.pageTitle}>Keyboard</h1>
        <p className={pageStyles.pageDesc}>
          Customize the app shortcuts used for navigation, search, and workspace dock panels.
        </p>
      </header>

      <section className={pageStyles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <h2 className={pageStyles.sectionTitle}>Shortcuts</h2>
            <p className={pageStyles.sectionDesc}>
              Click a shortcut, then press the replacement keys. Backspace clears it, Escape
              cancels, and Reset restores the default.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              update({ shortcuts: DEFAULT_KEYBOARD_SHORTCUTS })
              setRecordingId(null)
              setStatus({ kind: 'info', message: 'Keyboard shortcuts reset to defaults.' })
            }}
          >
            Reset
          </Button>
        </div>

        {Object.entries(definitionsByCategory).map(([category, definitions]) => (
          <div key={category} className={styles.shortcutList}>
            <h3 className={pageStyles.sectionTitle}>{category}</h3>
            {definitions.map((definition) => {
              const value = shortcuts[definition.id]
              const recording = recordingId === definition.id
              const isDefault = value === DEFAULT_KEYBOARD_SHORTCUTS[definition.id]
              return (
                <div key={definition.id} className={styles.shortcutRow}>
                  <div className={styles.shortcutText}>
                    <div className={styles.shortcutLabel}>{definition.label}</div>
                    <div className={styles.shortcutDescription}>{definition.description}</div>
                  </div>
                  <div className={styles.shortcutControls}>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className={`${styles.recordButton} ${recording ? styles.recording : ''}`}
                      onClick={() => {
                        setRecordingId(definition.id)
                        setStatus({
                          kind: 'info',
                          message: `Press the new shortcut for ${definition.label}.`
                        })
                      }}
                      onKeyDown={(event) => handleCapture(event, definition.id)}
                    >
                      {recording ? (
                        <span className={styles.recordingHint}>Press keys…</span>
                      ) : value ? (
                        <ShortcutKeys shortcut={value} />
                      ) : (
                        <span className={styles.emptyShortcut}>Disabled</span>
                      )}
                    </Button>
                    {isDefault ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={!value}
                        onClick={() => saveShortcut(definition.id, '')}
                      >
                        Clear
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          saveShortcut(definition.id, DEFAULT_KEYBOARD_SHORTCUTS[definition.id])
                        }
                      >
                        Reset
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ))}

        <div className={`${styles.status} ${status?.kind === 'error' ? styles.error : ''}`}>
          {status?.message}
        </div>
      </section>
    </div>
  )
}

function findConflict(
  id: KeyboardShortcutId,
  shortcut: string,
  shortcuts: KeyboardShortcutMap
): KeyboardShortcutId | null {
  if (!shortcut) return null
  const entry = Object.entries(shortcuts).find(
    ([otherId, otherShortcut]) => otherId !== id && otherShortcut === shortcut
  )
  return (entry?.[0] as KeyboardShortcutId | undefined) ?? null
}

function labelForShortcut(id: KeyboardShortcutId): string {
  return KEYBOARD_SHORTCUT_DEFINITIONS.find((definition) => definition.id === id)?.label ?? id
}
