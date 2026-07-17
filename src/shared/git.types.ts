/** Snapshot of a project folder's local git state, used by the workspace-dock Git panel. */
export interface GitWorkspaceStatus {
  hasRepo: boolean
  /** Current branch name, or null if detached/unborn HEAD. */
  branch: string | null
  filesChanged: number
  insertions: number
  deletions: number
}
