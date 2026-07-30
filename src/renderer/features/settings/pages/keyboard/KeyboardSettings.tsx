import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  KEYBOARD_SHORTCUT_DEFINITIONS,
  isBindableShortcut,
  shortcutFromEvent,
  type KeyboardShortcutDefinition
} from '@shared/keyboardShortcuts'
import type { AppSettings, KeyboardShortcutId, KeyboardShortcutMap } from '@shared/settings.types'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { ShortcutKeys } from '../../../../components/ShortcutKeys'
import pageStyles from '../../SettingsPage.module.css'
import styles from './KeyboardSettings.module.css'

interface KeyboardSettingsProps {
  settings: AppSettings
  update: (patch: Partial<AppSettings['keyboard']>) => void
}

interface Status {
  kind: 'info' | 'error'
  message: string
}

/** How long a row stays flagged after it lands a binding or blocks a conflict. */
const FLASH_MS = 1400

export function KeyboardSettings({ settings, update }: KeyboardSettingsProps): JSX.Element {
  const shortcuts = settings.keyboard?.shortcuts ?? DEFAULT_KEYBOARD_SHORTCUTS
  const [recordingId, setRecordingId] = useState<KeyboardShortcutId | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [query, setQuery] = useState('')
  const [flash, setFlash] = useState<{ id: KeyboardShortcutId; kind: 'saved' | 'conflict' } | null>(
    null
  )
  const flashTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    }
  }, [])

  const flashRow = (id: KeyboardShortcutId, kind: 'saved' | 'conflict'): void => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    setFlash({ id, kind })
    flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS)
  }

  const groups = useMemo(() => groupByCategory(KEYBOARD_SHORTCUT_DEFINITIONS), [])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return groups
    return groups
      .map(
        ([category, definitions]) =>
          [
            category,
            definitions.filter((definition) =>
              [category, definition.label, definition.description, shortcuts[definition.id] ?? '']
                .join(' ')
                .toLowerCase()
                .includes(needle)
            )
          ] as [string, KeyboardShortcutDefinition[]]
      )
      .filter(([, definitions]) => definitions.length > 0)
  }, [groups, query, shortcuts])

  const customized = KEYBOARD_SHORTCUT_DEFINITIONS.filter(
    (definition) => shortcuts[definition.id] !== DEFAULT_KEYBOARD_SHORTCUTS[definition.id]
  ).length
  const disabled = KEYBOARD_SHORTCUT_DEFINITIONS.filter(
    (definition) => !shortcuts[definition.id]
  ).length

  const saveShortcut = (id: KeyboardShortcutId, shortcut: string): void => {
    const conflict = findConflict(id, shortcut, shortcuts)
    if (conflict) {
      setStatus({
        kind: 'error',
        message: `${shortcut} is already assigned to ${labelForShortcut(conflict)}.`
      })
      // Flag the row that already owns the keys, not the one being edited —
      // that is the row the user has to change to free them up.
      flashRow(conflict, 'conflict')
      return
    }
    update({ shortcuts: { ...shortcuts, [id]: shortcut } })
    flashRow(id, 'saved')
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
          Every shortcut Anodex listens for, in one place. Click a key well and press the
          combination you want — Backspace clears it, Escape cancels.
        </p>
      </header>

      <section className={pageStyles.section}>
        <div className={styles.summaryGrid}>
          <div className={styles.summaryCard}>
            <span>Bindings</span>
            <strong>{KEYBOARD_SHORTCUT_DEFINITIONS.length}</strong>
            <small>Across {groups.length} groups</small>
          </div>
          <div className={`${styles.summaryCard} ${customized > 0 ? styles.summaryAccent : ''}`}>
            <span>Customized</span>
            <strong>{customized}</strong>
            <small>{customized > 0 ? 'Changed from default' : 'All at defaults'}</small>
          </div>
          <div className={`${styles.summaryCard} ${disabled > 0 ? styles.summaryMuted : ''}`}>
            <span>Disabled</span>
            <strong>{disabled}</strong>
            <small>{disabled > 0 ? 'No keys assigned' : 'Nothing turned off'}</small>
          </div>
        </div>

        <div className={styles.toolbar}>
          <div className={styles.search}>
            <Icon name="search" size={13} className={styles.searchIcon} />
            <input
              type="search"
              className={styles.searchInput}
              value={query}
              placeholder="Find a shortcut or key…"
              aria-label="Filter shortcuts"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                type="button"
                className={styles.searchClear}
                aria-label="Clear filter"
                onClick={() => setQuery('')}
              >
                <Icon name="close" size={11} />
              </button>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={customized === 0}
            onClick={() => {
              update({ shortcuts: DEFAULT_KEYBOARD_SHORTCUTS })
              setRecordingId(null)
              setStatus({ kind: 'info', message: 'Keyboard shortcuts reset to defaults.' })
            }}
          >
            Reset all
          </Button>
        </div>

        {visible.length === 0 ? (
          <p className={styles.empty}>No shortcut matches “{query.trim()}”.</p>
        ) : (
          visible.map(([category, definitions]) => (
            <div key={category} className={styles.group}>
              <div className={styles.groupHeader}>
                <h3 className={styles.groupTitle}>{category}</h3>
                <span className={styles.groupCount}>{definitions.length}</span>
                <span className={styles.groupRule} aria-hidden="true" />
              </div>
              <div className={styles.shortcutList}>
                {definitions.map((definition) => {
                  const value = shortcuts[definition.id]
                  const fallback = DEFAULT_KEYBOARD_SHORTCUTS[definition.id]
                  const recording = recordingId === definition.id
                  const isDefault = value === fallback
                  const rowFlash = flash?.id === definition.id ? flash.kind : null
                  return (
                    <div
                      key={definition.id}
                      className={[
                        styles.shortcutRow,
                        recording ? styles.rowRecording : '',
                        rowFlash === 'saved' ? styles.rowSaved : '',
                        rowFlash === 'conflict' ? styles.rowConflict : ''
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <div className={styles.shortcutText}>
                        <div className={styles.shortcutLabel}>
                          {definition.label}
                          {!isDefault && (
                            <span className={styles.changedDot} title="Changed from default" />
                          )}
                        </div>
                        <div className={styles.shortcutDescription}>{definition.description}</div>
                      </div>
                      <div className={styles.shortcutControls}>
                        <button
                          type="button"
                          className={`${styles.keyWell} ${recording ? styles.keyWellRecording : ''}`}
                          aria-label={`${definition.label} shortcut${
                            value ? `, currently ${value}` : ', currently disabled'
                          }`}
                          onClick={() => {
                            setRecordingId(definition.id)
                            setStatus({
                              kind: 'info',
                              message: `Press the new shortcut for ${definition.label}.`
                            })
                          }}
                          onBlur={() => {
                            if (recording) setRecordingId(null)
                          }}
                          onKeyDown={(event) => handleCapture(event, definition.id)}
                        >
                          {recording ? (
                            <span className={styles.recordingHint}>
                              <span className={styles.recordingPulse} aria-hidden="true" />
                              Press keys…
                            </span>
                          ) : value ? (
                            <ShortcutKeys shortcut={value} />
                          ) : (
                            <span className={styles.emptyShortcut}>Disabled</span>
                          )}
                        </button>
                        {isDefault ? (
                          <button
                            type="button"
                            className={styles.rowAction}
                            disabled={!value}
                            onClick={() => saveShortcut(definition.id, '')}
                          >
                            Clear
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={styles.rowAction}
                            title={fallback ? `Restore ${fallback}` : 'Restore default'}
                            onClick={() => saveShortcut(definition.id, fallback)}
                          >
                            Reset
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        )}

        <div
          className={`${styles.status} ${status?.kind === 'error' ? styles.error : ''}`}
          role="status"
          aria-live="polite"
        >
          {status && (
            <>
              <Icon name={status.kind === 'error' ? 'alert' : 'check'} size={12} />
              <span>{status.message}</span>
            </>
          )}
        </div>
      </section>
    </div>
  )
}

function groupByCategory(
  definitions: KeyboardShortcutDefinition[]
): Array<[string, KeyboardShortcutDefinition[]]> {
  const groups = new Map<string, KeyboardShortcutDefinition[]>()
  for (const definition of definitions) {
    groups.set(definition.category, [...(groups.get(definition.category) ?? []), definition])
  }
  return [...groups.entries()]
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
