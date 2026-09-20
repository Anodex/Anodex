import { reasonFor } from '@shared/result'
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceTreeNode } from '@shared/workspaceFiles.types'
import { anodex } from '../../../lib/anodex'
import { formatBytes } from '../../../lib/format'
import { useAnchoredPosition } from '../../../hooks/useAnchoredPosition'
import { Icon } from '../../../components/Icon'
import { notifyError } from '../../../stores/uiStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useFileViewer } from '../../file-viewer/useFileViewer'
import { useWorkspaceDock } from '../useWorkspaceDock'
import { DeleteConfirmDialog } from './DeleteConfirmDialog'
import styles from './NodeActionsMenu.module.css'

interface NodeActionsMenuProps {
  node: WorkspaceTreeNode
  /** Called after a successful delete so the panel can refresh its listing. */
  onDeleted: () => void
}

/**
 * Hover-revealed "..." trigger on a file or folder row that opens a small
 * actions menu. Positioned via a portal (not CSS `position: absolute` in
 * place) because the Files tree scrolls — the same reason
 * `InstalledModelsList`'s reliability popover uses one — and measured against
 * the window by `useAnchoredPosition` so it flips above the trigger (or clamps
 * horizontally) instead of getting cut off at an edge, which a fixed "always
 * open below" offset couldn't handle for rows near the bottom of a long tree.
 */
export function NodeActionsMenu({ node, onDeleted }: NodeActionsMenuProps): JSX.Element {
  const confirmDestructive = useSettingsStore((s) => s.settings?.general.confirmDestructive ?? true)
  const openInEditor = useFileViewer((s) => s.open)
  const setDockOpen = useWorkspaceDock((s) => s.setOpen)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const open = anchor !== null
  const menuStyle = useAnchoredPosition(anchor, menuRef)

  useLayoutEffect(() => {
    if (!open) return
    function handlePointerDown(event: MouseEvent): void {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setAnchor(null)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  const toggle = (event: React.MouseEvent): void => {
    event.stopPropagation()
    const trigger = event.currentTarget.getBoundingClientRect()
    setAnchor((current) => (current ? null : trigger))
  }

  const runAction =
    (action: () => Promise<void>) =>
    (event: React.MouseEvent): void => {
      event.stopPropagation()
      setAnchor(null)
      void action()
    }

  const copyAbsolutePath = async (): Promise<void> => {
    const result = await anodex.workspace.getAbsolutePath(node.path)
    if (result.ok) await navigator.clipboard.writeText(result.value)
    else notifyError('Could not copy path', reasonFor(result.error))
  }

  const copyRelativePath = async (): Promise<void> => {
    await navigator.clipboard.writeText(node.path)
  }

  const copyName = async (): Promise<void> => {
    await navigator.clipboard.writeText(node.name)
  }

  const reveal = async (): Promise<void> => {
    const result = await anodex.workspace.revealInFileExplorer(node.path)
    if (!result.ok) notifyError('Could not open the file explorer', reasonFor(result.error))
  }

  const openDefault = async (): Promise<void> => {
    const result = await anodex.workspace.openPath(node.path)
    if (!result.ok) notifyError('Could not open that', reasonFor(result.error))
  }

  const openEditor = (event: React.MouseEvent): void => {
    event.stopPropagation()
    setAnchor(null)
    if (node.type !== 'file') return
    setDockOpen(true)
    openInEditor(node)
  }

  const confirmDelete = (event: React.MouseEvent): void => {
    event.stopPropagation()
    setAnchor(null)
    if (confirmDestructive) setConfirmingDelete(true)
    else void handleDelete()
  }

  const handleDelete = async (): Promise<void> => {
    setConfirmingDelete(false)
    const result = await anodex.workspace.deletePath(node.path)
    if (result.ok) onDeleted()
    else notifyError('Could not delete that item', reasonFor(result.error))
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={toggle}
        aria-label={`${node.type === 'folder' ? 'Folder' : 'File'} actions`}
        title="Actions"
      >
        <Icon name="more-vertical" size={13} />
      </button>
      {open &&
        createPortal(
          <div ref={menuRef} className={styles.menu} style={menuStyle}>
            <button type="button" className={styles.item} onClick={runAction(copyAbsolutePath)}>
              Copy path
            </button>
            <button type="button" className={styles.item} onClick={runAction(copyRelativePath)}>
              Copy relative path
            </button>
            <button type="button" className={styles.item} onClick={runAction(copyName)}>
              Copy name
            </button>
            <div className={styles.divider} />
            <button type="button" className={styles.item} onClick={runAction(reveal)}>
              Reveal in file explorer
            </button>
            {node.type === 'file' && (
              <button type="button" className={styles.item} onClick={openEditor}>
                Open in editor
              </button>
            )}
            <button type="button" className={styles.item} onClick={runAction(openDefault)}>
              {node.type === 'folder' ? 'Open folder' : 'Open with default app'}
            </button>
            <div className={styles.divider} />
            <button
              type="button"
              className={`${styles.item} ${styles.danger}`}
              onClick={confirmDelete}
            >
              Delete
            </button>
            <div className={styles.divider} />
            <div className={styles.info}>
              {node.type === 'folder'
                ? `${node.children.length} item${node.children.length === 1 ? '' : 's'}`
                : formatBytes(node.sizeBytes)}
            </div>
          </div>,
          document.body
        )}
      {confirmingDelete && (
        <DeleteConfirmDialog
          name={node.name}
          isFolder={node.type === 'folder'}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => void handleDelete()}
        />
      )}
    </>
  )
}
