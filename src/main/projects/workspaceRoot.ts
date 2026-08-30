import { projectStore } from './ProjectStore'

/**
 * The folder a project points at, or null when there is no project.
 *
 * One definition on purpose. This existed as byte-identical private copies in
 * `change.handlers.ts` and `skill.handlers.ts`, and a third was nearly added for
 * agent runs - the same drift `SKIP_DIRS` and `TEXT_EXT` each have a comment
 * about. Every caller wants the same answer to the same question.
 */
export function workspaceRootForProject(projectId: string | null | undefined): string | null {
  if (!projectId) return null
  return (
    projectStore.getState().projects.find((project) => project.id === projectId)?.folderPath ?? null
  )
}
