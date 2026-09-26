import { reasonFor } from '@shared/result'
import { useProjectStore } from '../stores/projectStore'
import { useUiStore, notifyError } from '../stores/uiStore'
import { useSidebarModeStore } from '../stores/sidebarModeStore'
import { anodex } from '../lib/anodex'

/** Shared "New project" flow: pick a folder, create the project, then show Workspace. */
export function useCreateProject(): () => Promise<void> {
  const createProject = useProjectStore((s) => s.create)
  const setView = useUiStore((s) => s.setView)
  const setSidebarMode = useSidebarModeStore((s) => s.setMode)

  return async () => {
    const result = await anodex.tools.pickWorkspace()
    if (!result.ok) {
      notifyError('Could not select folder', reasonFor(result.error))
      return
    }
    const folderPath = result.value
    if (!folderPath) return
    const name = folderPath.split(/[/\\]/).pop() ?? 'New project'
    await createProject({ name, folderPath })
    setSidebarMode('workspace')
    setView('chat')
  }
}
