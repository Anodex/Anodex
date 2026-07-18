import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Project } from '@shared/project.types'
import { Icon } from '../Icon'
import { TextPromptDialog } from '../ui/TextPromptDialog'
import { useProjectStore } from '../../stores/projectStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './ProjectActionsMenu.module.css'

const DROPDOWN_WIDTH = 210

function dropdownPosition(rect: DOMRect): { top: number; left: number } {
  const left = Math.max(
    8,
    Math.min(rect.right - DROPDOWN_WIDTH, window.innerWidth - DROPDOWN_WIDTH - 8)
  )
  return { top: rect.bottom + 2, left }
}

interface ProjectActionsMenuProps {
  project: Project
  onOpenProjectFolder: (projectId: string) => void
  onRename: (project: Project, name: string) => void
  onArchive: (project: Project) => void
}

/** Small dropdown menu for project-level actions. */
export function ProjectActionsMenu({
  project,
  onOpenProjectFolder,
  onRename,
  onArchive
}: ProjectActionsMenuProps): JSX.Element {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [renaming, setRenaming] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const open = rect !== null

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      const target = event.target as Node
      const inTrigger = ref.current?.contains(target) ?? false
      const inDropdown = dropdownRef.current?.contains(target) ?? false
      if (!inTrigger && !inDropdown) setRect(null)
    }
    if (open) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handleRename = (): void => {
    setRect(null)
    setRenaming(true)
  }

  const handleOpenProjectFolder = (): void => {
    setRect(null)
    onOpenProjectFolder(project.id)
  }

  const handleProjectSettings = (): void => {
    setRect(null)
    void (async () => {
      await useProjectStore.getState().setActive(project.id)
      useUiStore.getState().openSettings('projects')
    })()
  }

  const handleArchive = (): void => {
    setRect(null)
    onArchive(project)
  }

  return (
    <div className={styles.menu} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        onClick={(event) => {
          event.stopPropagation()
          setRect((current) => (current ? null : event.currentTarget.getBoundingClientRect()))
        }}
        aria-label="Project actions"
        title="Project actions"
      >
        <Icon name="more-vertical" size={14} />
      </button>
      {rect &&
        createPortal(
          <div
            ref={dropdownRef}
            className={styles.dropdown}
            style={dropdownPosition(rect)}
            onClick={(event) => event.stopPropagation()}
          >
            <div className={styles.header}>
              <Icon name="folder" size={14} />
              <span>{project.name}</span>
            </div>
            <button type="button" className={styles.item} onClick={handleOpenProjectFolder}>
              <Icon name="folder" size={14} />
              <span>Open in Explorer</span>
            </button>
            <button type="button" className={styles.item} onClick={handleProjectSettings}>
              <Icon name="lightbulb" size={14} />
              <span>Project skills</span>
            </button>
            <button type="button" className={styles.item} onClick={handleRename}>
              <Icon name="pencil" size={14} />
              <span>Rename project</span>
            </button>
            <button
              type="button"
              className={`${styles.item} ${styles.danger}`}
              onClick={handleArchive}
            >
              <Icon name="archive" size={14} />
              <span>Archive project</span>
            </button>
          </div>,
          document.body
        )}
      {renaming && (
        <TextPromptDialog
          title="Rename project"
          label="Project name"
          initialValue={project.name}
          confirmLabel="Rename"
          onCancel={() => setRenaming(false)}
          onConfirm={(name) => {
            setRenaming(false)
            onRename(project, name)
          }}
        />
      )}
    </div>
  )
}
