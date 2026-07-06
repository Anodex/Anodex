import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  CreateProjectRequest,
  Project,
  ProjectsState,
  UpdateProjectRequest
} from '@shared/project.types'
import { createLogger } from '../utils/logger'
import { settingsStore } from '../settings/SettingsStore'
import { conversationStore } from '../conversations/ConversationStore'
import { projectMemoryStore } from './ProjectMemoryStore'

const log = createLogger('projects')

const DEFAULT_STATE: ProjectsState = {
  projects: [],
  activeProjectId: null
}

/**
 * Persists the user's projects in Electron's `userData` directory.
 *
 * A project is a named folder that scopes the AI's workspace tools. Switching
 * the active project also updates the global workspace root so the existing
 * tool confinement boundary keeps working without changes.
 */
class ProjectStore {
  private filePath = ''
  private cache: ProjectsState | null = null

  /** Must be called after `app.whenReady()`. */
  init(): void {
    const userData = app.getPath('userData')
    this.filePath = join(userData, 'projects.json')
    this.cache = this.load()
    this.migrateFromWorkspace()
    log.info('Initialised at', this.filePath)
  }

  getState(): ProjectsState {
    if (!this.cache) this.cache = this.load()
    return this.cache
  }

  create(request: CreateProjectRequest): Project {
    const state = this.getState()
    const project: Project = {
      id: generateId(),
      name: request.name.trim(),
      folderPath: request.folderPath,
      instructions: request.instructions?.trim() || undefined,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    state.projects = [project, ...state.projects]
    this.persist(state)
    return project
  }

  update(id: string, request: UpdateProjectRequest): Project {
    const state = this.getState()
    const index = state.projects.findIndex((p) => p.id === id)
    if (index === -1) throw new Error(`Project not found: ${id}`)
    const project = state.projects[index]
    const next: Project = {
      ...project,
      name: request.name?.trim() ?? project.name,
      folderPath: request.folderPath ?? project.folderPath,
      instructions:
        request.instructions !== undefined
          ? request.instructions.trim() || undefined
          : project.instructions,
      updatedAt: Date.now()
    }
    state.projects[index] = next
    if (state.activeProjectId === id) {
      settingsStore.update({ workspace: { root: next.folderPath } })
    }
    this.persist(state)
    return next
  }

  delete(id: string): void {
    const state = this.getState()
    state.projects = state.projects.filter((p) => p.id !== id)
    if (state.activeProjectId === id) {
      state.activeProjectId = state.projects[0]?.id ?? null
      settingsStore.update({ workspace: { root: state.projects[0]?.folderPath ?? null } })
    }
    conversationStore.deleteByProject(id)
    projectMemoryStore.delete(id)
    this.persist(state)
  }

  setActive(id: string | null): ProjectsState {
    const state = this.getState()
    if (id !== null && !state.projects.some((p) => p.id === id)) {
      throw new Error(`Project not found: ${id}`)
    }
    state.activeProjectId = id
    settingsStore.update({
      workspace: { root: state.projects.find((p) => p.id === id)?.folderPath ?? null }
    })
    this.persist(state)
    return state
  }

  private load(): ProjectsState {
    if (!existsSync(this.filePath)) {
      this.persist(DEFAULT_STATE)
      return DEFAULT_STATE
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as ProjectsState
      return {
        projects: raw.projects ?? [],
        activeProjectId: raw.activeProjectId ?? null
      }
    } catch (error) {
      log.warn('Failed to parse projects, falling back to defaults:', error)
      return DEFAULT_STATE
    }
  }

  private persist(state: ProjectsState): void {
    try {
      const dir = app.getPath('userData')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf-8')
      this.cache = state
    } catch (error) {
      log.error('Failed to persist projects:', error)
    }
  }

  /** One-time migration: if the user has a legacy workspace.root, turn it into the first project. */
  private migrateFromWorkspace(): void {
    const state = this.getState()
    if (state.projects.length > 0) return
    const workspaceRoot = settingsStore.get().workspace.root
    if (!workspaceRoot) return
    log.info('Migrating legacy workspace root to first project:', workspaceRoot)
    const project: Project = {
      id: generateId(),
      name: 'My workspace',
      folderPath: workspaceRoot,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    state.projects.push(project)
    state.activeProjectId = project.id
    this.persist(state)
  }
}

function generateId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export const projectStore = new ProjectStore()
