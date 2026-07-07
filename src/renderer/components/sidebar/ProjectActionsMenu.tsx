import { useEffect, useRef, useState } from 'react'
import type { Project } from '@shared/project.types'
import { Icon } from '../Icon'
import { TextPromptDialog } from '../ui/TextPromptDialog'
import styles from './ProjectActionsMenu.module.css'

interface ProjectActionsMenuProps {
  project: Project
  onRename: (project: Project, name: string) => void
  onDelete: (project: Project) => void
}

/** Small dropdown menu for project-level actions. */
export function ProjectActionsMenu({
  project,
  onRename,
  onDelete
}: ProjectActionsMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handleRename = (): void => {
    setOpen(false)
    setRenaming(true)
  }

  const handleDelete = (): void => {
    setOpen(false)
    onDelete(project)
  }

  return (
    <div className={styles.menu} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-label="Project actions"
        title="Project actions"
      >
        <Icon name="more-vertical" size={14} />
      </button>
      {open && (
        <div className={styles.dropdown}>
          <button type="button" className={styles.item} onClick={handleRename}>
            Rename
          </button>
          <button
            type="button"
            className={`${styles.item} ${styles.danger}`}
            onClick={handleDelete}
          >
            Delete
          </button>
        </div>
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
