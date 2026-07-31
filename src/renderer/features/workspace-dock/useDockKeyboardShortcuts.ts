import { useEffect } from 'react'
import { DEFAULT_KEYBOARD_SHORTCUTS, matchesShortcut } from '@shared/keyboardShortcuts'
import { useSettingsStore } from '../../stores/settingsStore'
import { isEditableTarget } from '../../hooks/useGlobalKeyboardShortcuts'
import { useWorkspaceDock } from './useWorkspaceDock'

/** Registers global keyboard shortcuts for toggling dock panels. */
export function useDockKeyboardShortcuts(enabled: boolean): void {
  const togglePanel = useWorkspaceDock((s) => s.togglePanel)
  const shortcuts = useSettingsStore((s) => s.settings?.keyboard.shortcuts)

  useEffect(() => {
    if (!enabled) return
    const activeShortcuts = shortcuts ?? DEFAULT_KEYBOARD_SHORTCUTS
    const handleKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return
      if (matchesShortcut(event, activeShortcuts.toggleDockFiles)) {
        event.preventDefault()
        togglePanel('files')
      } else if (matchesShortcut(event, activeShortcuts.toggleDockPlan)) {
        event.preventDefault()
        togglePanel('plan')
      } else if (matchesShortcut(event, activeShortcuts.toggleDockTerminal)) {
        event.preventDefault()
        togglePanel('terminal')
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [enabled, shortcuts, togglePanel])
}
