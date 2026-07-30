import { useEffect, useMemo } from 'react'
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  KEYBOARD_SHORTCUT_DEFINITIONS,
  type KeyboardShortcutDefinition
} from '@shared/keyboardShortcuts'
import { ShortcutKeys } from '../../components/ShortcutKeys'
import { Icon } from '../../components/Icon'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './ShortcutHelpOverlay.module.css'

/** Read-only cheat sheet of every active shortcut, opened with the
 *  `showShortcutHelp` binding. Editing lives in Settings → Keyboard. */
export function ShortcutHelpOverlay(): JSX.Element | null {
  const open = useUiStore((s) => s.shortcutHelpOpen)
  const setOpen = useUiStore((s) => s.setShortcutHelpOpen)
  const openSettings = useUiStore((s) => s.openSettings)
  const shortcuts = useSettingsStore((s) => s.settings?.keyboard.shortcuts)

  const groups = useMemo(() => groupByCategory(KEYBOARD_SHORTCUT_DEFINITIONS), [])

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Claim Esc so it closes the sheet instead of also stopping a reply.
      event.preventDefault()
      setOpen(false)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, setOpen])

  if (!open) return null

  const active = shortcuts ?? DEFAULT_KEYBOARD_SHORTCUTS

  return (
    <div className={styles.overlay} onClick={() => setOpen(false)}>
      <div
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>Keyboard shortcuts</h2>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.editLink}
              onClick={() => {
                setOpen(false)
                openSettings('keyboard')
              }}
            >
              Edit shortcuts
            </button>
            <button
              type="button"
              className={styles.close}
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        </header>

        <div className={styles.body}>
          {groups.map(([category, definitions]) => (
            <section key={category} className={styles.group}>
              <h3 className={styles.groupTitle}>{category}</h3>
              {definitions.map((definition) => (
                <div key={definition.id} className={styles.row}>
                  <span className={styles.rowLabel}>{definition.label}</span>
                  <ShortcutKeys shortcut={active[definition.id]} />
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
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
