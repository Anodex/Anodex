import { settingsStore } from '../settings/SettingsStore'
import { projectStore } from '../projects/ProjectStore'

/**
 * The folder a workspace call should resolve against.
 *
 * There were two answers to this and they disagreed. `checkpoints:*` resolves
 * against the *conversation's* project, looked up by the id in the request;
 * every handler here resolved against `settings.workspace.root`, which tracks
 * the *active* project — `ProjectStore` rewrites it whenever the active project
 * changes, and nothing else does.
 *
 * Those are the same folder right up until somebody opens a conversation
 * belonging to a project that is not the active one, which a phone does simply
 * by scrolling its list. Then the diff for a turn reads one project and the
 * file behind that diff reads another. The symptom is a file reader that cannot
 * find a file the diff beside it just drew.
 *
 * So a caller that knows which project it means says so, and is answered about
 * that project. A caller that does not — every existing renderer call — gets
 * the active project exactly as before.
 *
 * Every handler in `workspace.handlers.ts` goes through here, including the ones
 * that could only ever mean the active project: a window opening a file in
 * Explorer has no other project in mind. They call it with no argument, which
 * is the same expression they had before — but it is now the *only* place this
 * question is answered, rather than one of eight identical lines that would
 * drift apart the first time one of them needed to be different.
 */
export function rootFor(projectId?: string | null): string | null {
  if (projectId) {
    const project = projectStore.getState().projects.find((item) => item.id === projectId)
    // A project id that names nothing is not a reason to quietly answer about a
    // different folder; the caller asked about something specific.
    return project?.folderPath ?? null
  }
  return settingsStore.get().workspace.root
}
