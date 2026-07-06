/** Who most recently changed a workspace file, best-effort. */
export type FileEditedBy = 'user' | 'ai'

/** A single file in the active workspace, for the Files dock panel. */
export interface WorkspaceFileEntry {
  type: 'file'
  /** Path relative to the workspace root, forward-slashed. */
  path: string
  /** Final path segment, for display. */
  name: string
  sizeBytes: number
  /** Last modification time, ms since epoch. */
  modifiedAt: number
  editedBy: FileEditedBy
}

/** A folder in the active workspace, holding its own files/subfolders. */
export interface WorkspaceFolderEntry {
  type: 'folder'
  /** Path relative to the workspace root, forward-slashed. */
  path: string
  /** Final path segment, for display. */
  name: string
  children: WorkspaceTreeNode[]
}

/** One entry in the Files dock panel's tree — a file or a folder. */
export type WorkspaceTreeNode = WorkspaceFileEntry | WorkspaceFolderEntry
