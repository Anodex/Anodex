import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { ChangeSummary } from '@shared/change.types'
import { projectStore } from '../projects/ProjectStore'
import { changeStore } from '../changes/ChangeStore'

function workspaceRootForProject(projectId: string | null | undefined): string | null {
  if (!projectId) return null
  return (
    projectStore.getState().projects.find((project) => project.id === projectId)?.folderPath ?? null
  )
}

function toSummary(change: {
  slug: string
  title: string
  status: ChangeSummary['status']
  tasks: ChangeSummary['tasks']
}): ChangeSummary {
  return { slug: change.slug, title: change.title, status: change.status, tasks: change.tasks }
}

/** IPC handlers for the renderer-facing change catalog (Workspace Dock's Changes panel). */
export function registerChangeHandlers(): void {
  ipcMain.handle(IpcChannel.Changes.list, (_event, projectId?: string | null): ChangeSummary[] => {
    const workspaceRoot = workspaceRootForProject(projectId)
    if (!workspaceRoot) return []
    return changeStore.list(workspaceRoot).map(toSummary)
  })
}
