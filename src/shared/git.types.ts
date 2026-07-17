/** Snapshot of a project folder's local git state, used by the workspace-dock Git panel. */
export interface GitWorkspaceStatus {
  hasRepo: boolean
  /** Current branch name, or null if detached/unborn HEAD. */
  branch: string | null
  /** Short HEAD SHA when available. Null for unborn repositories. */
  headSha: string | null
  /** First configured remote name, usually `origin`. */
  remote: string | null
  /** Upstream branch, for example `origin/main`. */
  upstream: string | null
  ahead: number
  behind: number
  filesChanged: number
  staged: number
  unstaged: number
  untracked: number
  insertions: number
  deletions: number
  canPush: boolean
}
