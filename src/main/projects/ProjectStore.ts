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
import { memoryStore } from '../memory/MemoryStore'

const log = createLogger('projects')

const DEFAULT_STATE: ProjectsState = {
  projects: [],
  activeProjectId: null
}

export function normalizePinnedSkillNames(names: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const name of names ?? []) {
    const trimmed = name.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

export function normalizeProject(
  project: Omit<Project, 'pinnedSkillNames'> & { pinnedSkillNames?: string[] }
): Project {
  return {
    ...project,
    pinnedSkillNames: normalizePinnedSkillNames(project.pinnedSkillNames),
    archived: project.archived ?? false
  }
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
    return {
      projects: this.cache.projects.filter((project) => !project.archived),
      activeProjectId: this.cache.activeProjectId
    }
  }

  listArchived(): Project[] {
    if (!this.cache) this.cache = this.load()
    return this.cache.projects
      .filter((project) => project.archived)
      .sort((a, b) => (b.archivedAt ?? b.updatedAt) - (a.archivedAt ?? a.updatedAt))
  }

  private getAllState(): ProjectsState {
    if (!this.cache) this.cache = this.load()
    return this.cache
  }

  create(request: CreateProjectRequest): Project {
    const state = this.getAllState()
    const project: Project = {
      id: generateId(),
      name: request.name.trim(),
      folderPath: request.folderPath,
      instructions: request.instructions?.trim() || undefined,
      pinnedSkillNames: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    state.projects = [project, ...state.projects]
    this.persist(state)
    return project
  }

  update(id: string, request: UpdateProjectRequest): Project {
    const state = this.getAllState()
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
      pinnedSkillNames:
        request.pinnedSkillNames !== undefined
          ? normalizePinnedSkillNames(request.pinnedSkillNames)
          : project.pinnedSkillNames,
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
    this.archive(id)
  }

  archive(id: string): void {
    const state = this.getAllState()
    const project = state.projects.find((p) => p.id === id)
    if (!project) return
    project.archived = true
    project.archivedAt = Date.now()
    project.updatedAt = Date.now()
    if (state.activeProjectId === id) {
      const nextProject = state.projects.find((p) => !p.archived)
      state.activeProjectId = nextProject?.id ?? null
      settingsStore.update({ workspace: { root: nextProject?.folderPath ?? null } })
    }
    conversationStore.deleteByProject(id)
    this.persist(state)
  }

  restore(id: string): void {
    const state = this.getAllState()
    const project = state.projects.find((p) => p.id === id)
    if (!project) return
    project.archived = false
    project.archivedAt = undefined
    project.updatedAt = Date.now()
    conversationStore.restoreByProject(id)
    this.persist(state)
  }

  deletePermanent(id: string): void {
    const state = this.getAllState()
    state.projects = state.projects.filter((p) => p.id !== id)
    if (state.activeProjectId === id) {
      const nextProject = state.projects.find((p) => !p.archived)
      state.activeProjectId = nextProject?.id ?? null
      settingsStore.update({ workspace: { root: nextProject?.folderPath ?? null } })
    }
    conversationStore.deleteByProjectPermanent(id)
    projectMemoryStore.delete(id)
    memoryStore.deleteAllForProject(id)
    this.persist(state)
  }

  setActive(id: string | null): ProjectsState {
    const state = this.getAllState()
    if (id !== null && !state.projects.some((p) => p.id === id && !p.archived)) {
      throw new Error(`Project not found: ${id}`)
    }
    state.activeProjectId = id
    settingsStore.update({
      workspace: { root: state.projects.find((p) => p.id === id)?.folderPath ?? null }
    })
    this.persist(state)
    return this.getState()
  }

  private load(): ProjectsState {
    if (!existsSync(this.filePath)) {
      this.persist(DEFAULT_STATE)
      return DEFAULT_STATE
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as {
        projects?: Array<Omit<Project, 'pinnedSkillNames'> & { pinnedSkillNames?: string[] }>
        activeProjectId?: string | null
      }
      const rawProjects = raw.projects ?? []
      const projects = rawProjects.map(normalizeProject)
      const activeProjectId =
        raw.activeProjectId && projects.some((p) => p.id === raw.activeProjectId && !p.archived)
          ? raw.activeProjectId
          : null
      const state = { projects, activeProjectId }
      const shouldPersist =
        activeProjectId !== raw.activeProjectId ||
        rawProjects.some((project, index) => {
          const normalized = projects[index]
          return (
            project.archived === undefined ||
            project.pinnedSkillNames === undefined ||
            normalizePinnedSkillNames(project.pinnedSkillNames).join('\0') !==
              normalized.pinnedSkillNames.join('\0')
          )
        })
      if (shouldPersist) this.persist(state)
      return state
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
    const state = this.getAllState()
    if (state.projects.length > 0) return
    const workspaceRoot = settingsStore.get().workspace.root
    if (!workspaceRoot) return
    log.info('Migrating legacy workspace root to first project:', workspaceRoot)
    const project: Project = {
      id: generateId(),
      name: 'My workspace',
      folderPath: workspaceRoot,
      pinnedSkillNames: [],
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
