import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { SkillSummary } from '@shared/skill.types'
import { projectStore } from '../projects/ProjectStore'
import { skillStore } from '../skills/SkillStore'

function workspaceRootForProject(projectId: string | null | undefined): string | null {
  if (!projectId) return null
  return (
    projectStore.getState().projects.find((project) => project.id === projectId)?.folderPath ?? null
  )
}

function toSummary(skill: {
  name: string
  description: string
  scope: SkillSummary['scope']
  keywords: string[]
}): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    keywords: skill.keywords
  }
}

/** IPC handlers for the renderer-facing skill catalog. */
export function registerSkillHandlers(): void {
  ipcMain.handle(IpcChannel.Skills.list, (_event, projectId?: string | null) => {
    const workspaceRoot = workspaceRootForProject(projectId)
    return skillStore.list(workspaceRoot).map(toSummary)
  })
}
