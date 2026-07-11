import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import type { Skill } from '@shared/skill.types'
import { createLogger } from '../utils/logger'
import { parseSkillFile } from './skillFile'

const log = createLogger('skill-store')

/**
 * Reads skills from their own `userData/skills/*.md` files. Unlike every
 * other `*Store` in this codebase, this one keeps no in-memory cache: those
 * stores are the sole writer of their file, but skill files are meant to be
 * hand-edited (or dropped in fresh) by the user while the app is running, so
 * `list()` re-reads the directory every call. The catalog is small and this
 * isn't a hot path (only fires when `find_skill`/`load_skill` run), so the
 * simplicity is worth the extra disk read.
 */
class SkillStore {
  private dir = ''

  /** Must be called after `app.whenReady()`. */
  init(): void {
    this.dir = join(app.getPath('userData'), 'skills')
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    log.info('Initialised at', this.dir)
  }

  list(): Skill[] {
    if (!this.dir) return []
    let entries: string[]
    try {
      entries = readdirSync(this.dir).filter((name) => name.endsWith('.md'))
    } catch (error) {
      log.warn('Failed to read skills directory:', error)
      return []
    }
    const skills: Skill[] = []
    for (const entry of entries) {
      const filePath = join(this.dir, entry)
      try {
        const raw = readFileSync(filePath, 'utf-8')
        skills.push(parseSkillFile(raw, filePath))
      } catch (error) {
        log.warn(`Skipping invalid skill file "${filePath}":`, error)
      }
    }
    return skills
  }

  get(name: string): Skill | null {
    return this.list().find((skill) => skill.name === name) ?? null
  }

  /** Absolute path to the skills directory, for user-facing messages. */
  getDir(): string {
    return this.dir
  }
}

export const skillStore = new SkillStore()
