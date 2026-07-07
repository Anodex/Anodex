import { create } from 'zustand'
import type {
  CreateProjectRequest,
  Project,
  ProjectsState,
  UpdateProjectRequest
} from '@shared/project.types'
import { anodex } from '../lib/anodex'
import { notifyError } from './uiStore'
import { useSettingsStore } from './settingsStore'

interface ProjectState extends ProjectsState {
  loaded: boolean
  load: () => Promise<void>
  create: (request: CreateProjectRequest) => Promise<void>
  update: (id: string, request: UpdateProjectRequest) => Promise<void>
  delete: (id: string) => Promise<void>
  setActive: (id: string | null) => Promise<void>
  openFolder: (id: string) => Promise<void>
}

/** Mirrors the persisted project list from the main process. */
export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  activeProjectId: null,
  loaded: false,

  load: async () => {
    const state = await anodex.projects.list()
    set({ ...state, loaded: true })
  },

  create: async (request) => {
    const project = await anodex.projects.create(request)
    const state = await anodex.projects.setActive(project.id)
    set({ ...state })
    await refreshWorkspaceSettings()
  },

  update: async (id, request) => {
    try {
      await anodex.projects.update(id, request)
      const state = await anodex.projects.list()
      set({ ...state })
      await refreshWorkspaceSettings()
    } catch (error) {
      notifyError('Could not update project', error instanceof Error ? error.message : undefined)
    }
  },

  delete: async (id) => {
    try {
      await anodex.projects.delete(id)
      const state = await anodex.projects.list()
      set({ ...state })
      await refreshWorkspaceSettings()
    } catch (error) {
      notifyError('Could not delete project', error instanceof Error ? error.message : undefined)
    }
  },

  setActive: async (id) => {
    try {
      const state = await anodex.projects.setActive(id)
      set({ ...state })
      await refreshWorkspaceSettings()
    } catch (error) {
      notifyError('Could not switch project', error instanceof Error ? error.message : undefined)
    }
  },

  openFolder: async (id) => {
    try {
      await anodex.projects.openFolder(id)
    } catch (error) {
      notifyError(
        'Could not open project folder',
        error instanceof Error ? error.message : undefined
      )
    }
  }
}))

/**
 * Project create/update/delete/setActive can all change `settings.workspace.root`
 * as a side effect on the main process (see `ProjectStore` there). Re-fetch
 * settings so the renderer's cache — read by the chat composer's workspace
 * banner and tool gating — doesn't go stale until an unrelated settings write.
 */
async function refreshWorkspaceSettings(): Promise<void> {
  await useSettingsStore.getState().load()
}

/** Convenience selector for the currently active project. */
export function getActiveProject(
  projects: Project[],
  activeProjectId: string | null
): Project | null {
  return projects.find((p) => p.id === activeProjectId) ?? null
}
