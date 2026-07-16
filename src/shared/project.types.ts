/** A project groups chats around a single workspace folder. */
export interface Project {
  id: string
  name: string
  /** Absolute path of the folder the AI's tools are scoped to. */
  folderPath: string
  /**
   * Optional per-project rules folded into the system prompt when this project
   * is active (like an AGENTS.md) — conventions, commands, do's and don'ts.
   */
  instructions?: string
  /** Skill names that should be treated as active by default for this project. */
  pinnedSkillNames: string[]
  /** Optional `owner/repository` used as the default target for GitHub MCP tools. */
  githubRepository?: string
  createdAt: number
  updatedAt: number
  /** Archived projects are hidden from the sidebar until restored from Settings. */
  archived?: boolean
  archivedAt?: number
}

/** Persisted project collection. */
export interface ProjectsState {
  projects: Project[]
  /** The project currently selected in the UI, or null if none. */
  activeProjectId: string | null
}

export type CreateProjectRequest = Pick<Project, 'name' | 'folderPath'> &
  Partial<Pick<Project, 'instructions'>>
export type UpdateProjectRequest = Partial<
  Pick<Project, 'name' | 'folderPath' | 'instructions' | 'pinnedSkillNames' | 'githubRepository'>
>
