import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type {
  SkillDocument,
  SkillReadRequest,
  SkillSaveRequest,
  SkillSummary
} from '@shared/skill.types'
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

  ipcMain.handle(IpcChannel.Skills.read, (_event, request: SkillReadRequest): SkillDocument => {
    const workspaceRoot = workspaceRootForProject(request.projectId)
    return {
      name: request.name,
      scope: request.scope,
      content: skillStore.readMarkdown(request.name, request.scope, workspaceRoot)
    }
  })

  ipcMain.handle(IpcChannel.Skills.save, (_event, request: SkillSaveRequest): SkillSummary => {
    const workspaceRoot = workspaceRootForProject(request.projectId)
    const saved = skillStore.saveMarkdown(
      request.scope,
      request.content,
      request.originalName,
      workspaceRoot
    )
    const skill = skillStore.get(saved.name, workspaceRoot)
    if (!skill) throw new Error(`Saved skill "${saved.name}" could not be reloaded.`)
    return toSummary(skill)
  })
}
