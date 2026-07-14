/**
 * Types for persisted change proposals — a repo-local, human-readable record
 * of a planned change (why + a task checklist), stored as one markdown file
 * per change under a project's `.anodex/changes/` directory. Survives the
 * conversation, unlike `write_plan`'s ephemeral, conversation-scoped plan,
 * and gets folded into the project's living spec (`.anodex/SPEC.md`) once
 * archived.
 */

export type ChangeStatus = 'proposed' | 'in_progress' | 'done' | 'archived'

export interface ChangeTask {
  title: string
  done: boolean
}

/** A single change: one `.anodex/changes/<slug>/proposal.md` file. */
export interface Change {
  slug: string
  title: string
  status: ChangeStatus
  why: string
  tasks: ChangeTask[]
  createdAt: string
  updatedAt: string
  /** Absolute path to the source file, for diagnostics. */
  filePath: string
}

/** Change metadata safe to expose to renderer UI. */
export type ChangeSummary = Pick<Change, 'slug' | 'title' | 'status' | 'tasks'>
