import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import type { Skill } from '@shared/skill.types'
import { createLogger } from '../utils/logger'
import { listSkillCatalog, projectSkillsDir } from './skillCatalog'
import {
  readSkillMarkdown,
  writeSkillMarkdown,
  deleteSkillMarkdown,
  type SkillWriteResult
} from './skillLibrary'
import { seedPersonalSkills } from './seedSkills'

const log = createLogger('skill-store')

/**
 * Where the bundled sample skills live — differs between a dev run and a
 * packaged build, same split as the bundled embedding model (see
 * `EmbeddingService.resolveModelPath`) and driven by the matching
 * `extraResources` entry in `electron-builder.yml`.
 */
function resolveBundledSkillsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'resources', 'skills')
}

/**
 * Reads skills from project `.anodex/skills/*.md` files and personal
 * `userData/skills/*.md` files. Unlike every other `*Store` in this codebase,
 * this one keeps no in-memory cache: skill files are meant to be hand-edited
 * (or dropped in fresh) while the app is running, so `list()` re-reads the
 * relevant directories every call. The catalog is small and this isn't a hot
 * path (only fires when `find_skill`/`load_skill` run), so the simplicity is
 * worth the extra disk read.
 */
class SkillStore {
  private dir = ''

  /** Must be called after `app.whenReady()`. */
  init(): void {
    this.dir = join(app.getPath('userData'), 'skills')
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    // Best-effort: a missing or unreadable `resources/skills` means the user
    // starts with an empty library, which is the pre-seeding behaviour — never
    // a reason to fail startup.
    try {
      const seeded = seedPersonalSkills({
        bundledDir: resolveBundledSkillsDir(),
        personalDir: this.dir
      })
      if (seeded.length > 0) log.info(`Seeded ${seeded.length} sample skills:`, seeded.join(', '))
    } catch (error) {
      log.warn('Failed to seed sample skills:', error)
    }
    log.info('Initialised at', this.dir)
  }

  list(workspaceRoot?: string | null): Skill[] {
    if (!this.dir) return []
    return listSkillCatalog({ personalDir: this.dir, workspaceRoot })
  }

  get(name: string, workspaceRoot?: string | null): Skill | null {
    return this.list(workspaceRoot).find((skill) => skill.name === name) ?? null
  }

  readMarkdown(name: string, scope: Skill['scope'], workspaceRoot?: string | null): string {
    return readSkillMarkdown({ personalDir: this.dir, workspaceRoot, scope, name })
  }

  deleteMarkdown(name: string, scope: Skill['scope'], workspaceRoot?: string | null): void {
    deleteSkillMarkdown({ personalDir: this.dir, workspaceRoot, scope, name })
  }

  saveMarkdown(
    scope: Skill['scope'],
    content: string,
    originalName?: string | null,
    workspaceRoot?: string | null
  ): SkillWriteResult {
    return writeSkillMarkdown({
      personalDir: this.dir,
      workspaceRoot,
      scope,
      originalName,
      content
    })
  }

  /** Absolute path to the skills directory, for user-facing messages. */
  getDir(): string {
    return this.dir
  }

  /** Absolute path to the active project's skills directory, for user-facing messages. */
  getProjectDir(workspaceRoot: string): string {
    return projectSkillsDir(workspaceRoot)
  }
}

export const skillStore = new SkillStore()
