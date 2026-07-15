import { useProjectStore } from '../stores/projectStore'
import { useUiStore, notifyError } from '../stores/uiStore'
import { anodex } from '../lib/anodex'

/** Shared "New project" flow: pick a folder, create the project, switch to chat.
 *  Used by both the full sidebar and its collapsed icon rail. */
export function useCreateProject(): () => Promise<void> {
  const createProject = useProjectStore((s) => s.create)
  const setView = useUiStore((s) => s.setView)

  return async () => {
    const result = await anodex.tools.pickWorkspace()
    if (!result.ok) {
      notifyError('Could not select folder', result.error.message)
      return
    }
    const folderPath = result.value
    if (!folderPath) return
    const name = folderPath.split(/[/\\]/).pop() ?? 'New project'
    await createProject({ name, folderPath })
    setView('chat')
  }
}
