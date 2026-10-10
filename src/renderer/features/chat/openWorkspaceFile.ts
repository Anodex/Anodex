import type { WorkspaceFileEntry, WorkspaceTreeNode } from '@shared/workspaceFiles.types'
import { anodex } from '../../lib/anodex'
import { notifyError } from '../../stores/uiStore'
import { useFileViewer } from '../file-viewer/useFileViewer'
import { useWorkspaceDock } from '../workspace-dock/useWorkspaceDock'

/**
 * Open a project file in the dock's viewer, by its workspace-relative path.
 * A file the turn changed may since have been moved or deleted, and says so
 * rather than opening nothing.
 */
export async function openWorkspaceFile(path: string): Promise<void> {
  const listed = await anodex.workspace.listFiles()
  const entry = listed.ok ? findFile(listed.value, path) : null
  if (!entry) {
    notifyError('File not found', `${path} is no longer in the project.`)
    return
  }
  useWorkspaceDock.getState().setOpen(true)
  useFileViewer.getState().open(entry)
}

function findFile(nodes: WorkspaceTreeNode[], path: string): WorkspaceFileEntry | null {
  for (const node of nodes) {
    if (node.type === 'file') {
      if (node.path === path) return node
    } else if (path.startsWith(`${node.path}/`)) {
      const found = findFile(node.children, path)
      if (found) return found
    }
  }
  return null
}
