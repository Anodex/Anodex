import { useState } from 'react'
import type {
  WorkspaceFileEntry,
  WorkspaceFolderEntry,
  WorkspaceTreeNode
} from '@shared/workspaceFiles.types'
import { FileTypeIcon } from '../../../components/FileTypeIcon'
import { Icon } from '../../../components/Icon'
import { ANODEX_FILE_DRAG_TYPE } from '../../../lib/attachments'
import { formatRelativeTime } from '../../../lib/time'
import { useFileViewer } from '../../file-viewer/useFileViewer'
import { useWorkspaceDock } from '../useWorkspaceDock'
import { NodeActionsMenu } from './NodeActionsMenu'
import styles from './FilesPanel.module.css'

/** Indent per nesting level, in pixels. */
const INDENT_PX = 14

/** One row in the Files tree — a folder (expandable) or a file, indented to its depth. */
export function FileTreeRow({
  node,
  depth,
  onRefresh,
  forceExpanded
}: {
  node: WorkspaceTreeNode
  depth: number
  onRefresh: () => void
  /** While a search is active, expand every folder regardless of its own toggle state. */
  forceExpanded?: boolean
}): JSX.Element {
  return node.type === 'folder' ? (
    <FolderRow node={node} depth={depth} onRefresh={onRefresh} forceExpanded={forceExpanded} />
  ) : (
    <FileRow node={node} depth={depth} onRefresh={onRefresh} />
  )
}

function FolderRow({
  node,
  depth,
  onRefresh,
  forceExpanded
}: {
  node: WorkspaceFolderEntry
  depth: number
  onRefresh: () => void
  forceExpanded?: boolean
}): JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const isExpanded = expanded || Boolean(forceExpanded)

  return (
    <li>
      <div className={styles.row} style={{ paddingLeft: depth * INDENT_PX }} title={node.path}>
        <button
          type="button"
          className={styles.disclosureButton}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon
            name={isExpanded ? 'chevron-down' : 'chevron-right'}
            size={12}
            className={styles.disclosure}
          />
          <Icon name="folder" size={13} className={styles.folderIcon} />
          <span className={styles.name}>{node.name}</span>
        </button>
        <span className={styles.count}>{node.children.length}</span>
        <span className={styles.actions}>
          <NodeActionsMenu node={node} onDeleted={onRefresh} />
        </span>
      </div>
      {isExpanded && (
        <ul className={styles.tree}>
          {node.children.map((child) => (
            <FileTreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              onRefresh={onRefresh}
              forceExpanded={forceExpanded}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function FileRow({
  node,
  depth,
  onRefresh
}: {
  node: WorkspaceFileEntry
  depth: number
  onRefresh: () => void
}): JSX.Element {
  const openFile = useFileViewer((s) => s.open)
  const setDockOpen = useWorkspaceDock((s) => s.setOpen)

  return (
    <li>
      <div
        className={styles.row}
        style={{ paddingLeft: depth * INDENT_PX, cursor: 'pointer' }}
        title={node.path}
        draggable
        onClick={() => {
          setDockOpen(true)
          openFile(node)
        }}
        onDragStart={(event) => {
          event.dataTransfer.setData(
            ANODEX_FILE_DRAG_TYPE,
            JSON.stringify({ path: node.path, name: node.name })
          )
          event.dataTransfer.setData('text/plain', node.path)
          event.dataTransfer.effectAllowed = 'copy'
        }}
      >
        <span className={styles.disclosure} aria-hidden="true" />
        <span className={styles.fileIcon}>
          <FileTypeIcon fileName={node.name} size={13} />
        </span>
        <span className={styles.name}>{node.name}</span>
        <span
          className={`${styles.editedBy} ${styles[node.editedBy]}`}
          title={node.editedBy === 'ai' ? 'Last edited by Anodex' : 'Last edited by you'}
        >
          <Icon name={node.editedBy === 'ai' ? 'sparkle' : 'user'} size={12} />
        </span>
        <span className={styles.time}>{formatRelativeTime(node.modifiedAt)}</span>
        <span className={styles.actions}>
          <NodeActionsMenu node={node} onDeleted={onRefresh} />
        </span>
      </div>
    </li>
  )
}
