import type { Change } from '@shared/change.types'
import { listChanges } from './changeCatalog'
import {
  archiveChangeMarkdown,
  createChangeMarkdown,
  updateChangeTaskMarkdown
} from './changeLibrary'

/**
 * Reads/writes a project's changes from its `.anodex/changes` proposal.md
 * files. No in-memory cache — files are meant to be hand-editable while the
 * app is running, same reasoning as `SkillStore`, and this isn't a hot path.
 */
class ChangeStore {
  list(workspaceRoot: string): Change[] {
    return listChanges(workspaceRoot)
  }

  get(workspaceRoot: string, slug: string): Change | null {
    return this.list(workspaceRoot).find((change) => change.slug === slug) ?? null
  }

  create(workspaceRoot: string, title: string, why: string, taskTitles: string[]): Change {
    return createChangeMarkdown(workspaceRoot, title, why, taskTitles)
  }

  updateTask(workspaceRoot: string, slug: string, taskIndex: number, done: boolean): Change {
    return updateChangeTaskMarkdown(workspaceRoot, slug, taskIndex, done)
  }

  archive(workspaceRoot: string, slug: string): Change {
    return archiveChangeMarkdown(workspaceRoot, slug)
  }
}

export const changeStore = new ChangeStore()
