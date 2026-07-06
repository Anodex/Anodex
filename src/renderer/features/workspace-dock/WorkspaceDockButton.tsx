import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/ui/IconButton'
import { useWorkspaceDock } from './useWorkspaceDock'
import { useDockKeyboardShortcuts } from './useDockKeyboardShortcuts'
import { WorkspaceDockDropdown } from './WorkspaceDockDropdown'
import styles from './WorkspaceDockButton.module.css'

/** Top-right dock icon button that opens the panel selector dropdown. */
export function WorkspaceDockButton(): JSX.Element {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dockOpen = useWorkspaceDock((s) => s.open)
  const containerRef = useRef<HTMLDivElement>(null)

  useDockKeyboardShortcuts()

  useEffect(() => {
    if (!dropdownOpen) return
    const handle = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setDropdownOpen(false)
      }
    }
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDropdownOpen(false)
    }
    document.addEventListener('mousedown', handle)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handle)
      document.removeEventListener('keydown', handleKey)
    }
  }, [dropdownOpen])

  return (
    <div className={styles.container} ref={containerRef}>
      <IconButton
        label="Workspace Dock"
        icon={<Icon name="panel-right" size={18} />}
        size="sm"
        className={dockOpen ? styles.active : undefined}
        onClick={() => setDropdownOpen((v) => !v)}
      />
      {dropdownOpen && <WorkspaceDockDropdown />}
    </div>
  )
}
