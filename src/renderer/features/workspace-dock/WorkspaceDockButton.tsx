import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/ui/IconButton'
import { useWorkspaceDock } from './useWorkspaceDock'
import { useDockKeyboardShortcuts } from './useDockKeyboardShortcuts'
import { useWorkspaceDockProjectId } from './useWorkspaceDockAvailability'
import { WorkspaceDockDropdown } from './WorkspaceDockDropdown'
import styles from './WorkspaceDockButton.module.css'

/** Top-right dock icon button. Click toggles the dock open/closed directly;
 *  hovering reveals the panel-selector dropdown instead of requiring a click,
 *  so picking which panels show doesn't fight with the open/close action. */
export function WorkspaceDockButton(): JSX.Element | null {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dockOpen = useWorkspaceDock((s) => s.open)
  const setDockOpen = useWorkspaceDock((s) => s.setOpen)
  const dockProjectId = useWorkspaceDockProjectId()
  const containerRef = useRef<HTMLDivElement>(null)
  // The dropdown renders a few px below the button (see `top: calc(100% +
  // 4px)` in its own CSS) so there's a small gap that isn't over any element
  // — the instant the cursor crosses it, a plain mouseleave fires and closes
  // the dropdown before it's reachable. Closing on a short delay instead
  // (cancelled by re-entering either the button or the dropdown) gives the
  // cursor time to cross that gap without needing pixel-perfect movement.
  const closeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  useDockKeyboardShortcuts(Boolean(dockProjectId))

  useEffect(() => {
    if (!dropdownOpen) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDropdownOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [dropdownOpen])

  useEffect(() => {
    return () => {
      if (closeTimeout.current) clearTimeout(closeTimeout.current)
    }
  }, [])

  useEffect(() => {
    if (dockProjectId) return
    setDropdownOpen(false)
    if (closeTimeout.current) {
      clearTimeout(closeTimeout.current)
      closeTimeout.current = null
    }
  }, [dockProjectId])

  const openDropdown = (): void => {
    if (closeTimeout.current) {
      clearTimeout(closeTimeout.current)
      closeTimeout.current = null
    }
    setDropdownOpen(true)
  }

  const scheduleCloseDropdown = (): void => {
    closeTimeout.current = setTimeout(() => setDropdownOpen(false), 200)
  }

  if (!dockProjectId) return null

  return (
    <div
      className={styles.container}
      ref={containerRef}
      onMouseEnter={openDropdown}
      onMouseLeave={scheduleCloseDropdown}
    >
      <IconButton
        label={dockOpen ? 'Collapse workspace dock' : 'Expand workspace dock'}
        icon={<Icon name="panel-right" size={18} />}
        size="sm"
        className={dockOpen ? styles.active : undefined}
        onClick={() => setDockOpen(!dockOpen)}
      />
      {dropdownOpen && <WorkspaceDockDropdown />}
    </div>
  )
}
