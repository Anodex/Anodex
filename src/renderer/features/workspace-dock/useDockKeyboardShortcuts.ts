import { useEffect } from 'react'
import { useWorkspaceDock } from './useWorkspaceDock'

/** Registers global keyboard shortcuts for toggling dock panels. */
export function useDockKeyboardShortcuts(): void {
  const togglePanel = useWorkspaceDock((s) => s.togglePanel)

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || !event.shiftKey) return
      const key = event.key.toUpperCase()
      if (key === 'F') {
        event.preventDefault()
        togglePanel('files')
      } else if (key === 'P') {
        event.preventDefault()
        togglePanel('plan')
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [togglePanel])
}
