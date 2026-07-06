import { create } from 'zustand'
import type { WorkspaceFileEntry } from '@shared/workspaceFiles.types'

interface FileViewerState {
  node: WorkspaceFileEntry | null
  /** Bumped on every successful save so `FilesPanel` can refresh mtime/size/edited-by. */
  saveVersion: number
  open: (node: WorkspaceFileEntry) => void
  close: () => void
  notifySaved: () => void
}

/** Which workspace file, if any, is currently open in the in-app viewer/editor. */
export const useFileViewer = create<FileViewerState>((set) => ({
  node: null,
  saveVersion: 0,

  open: (node) => set({ node }),
  close: () => set({ node: null }),
  notifySaved: () => set((s) => ({ saveVersion: s.saveVersion + 1 }))
}))
