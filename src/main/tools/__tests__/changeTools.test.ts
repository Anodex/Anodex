import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  archiveChangeTool,
  listChangesTool,
  proposeChangeTool,
  updateChangeTaskTool
} from '../changeTools'
import type { WorkspaceToolContext } from '../types'
import { createMockContext, createMockDefine } from './test-helpers'

type ProposeHandler = (args: { title: string; why: string; tasks: string[] }) => Promise<string>
type UpdateTaskHandler = (args: {
  slug: string
  taskNumber: number
  done: boolean
}) => Promise<string>
type ArchiveHandler = (args: { slug: string }) => Promise<string>
type ListHandler = () => Promise<string>

let workspaceRoot: string

function context(): WorkspaceToolContext {
  return createMockContext(workspaceRoot)
}

describe('change tools', () => {
  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'anodex-change-tools-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  describe('propose_change', () => {
    it('creates a persisted change with the given tasks', async () => {
      const ctx = context()
      const tool = proposeChangeTool(createMockDefine(), ctx) as unknown as {
        handler: ProposeHandler
      }

      const result = await tool.handler({
        title: 'Add dark mode',
        why: 'Users asked for it.',
        tasks: ['Add theme toggle', 'Wire up CSS variables']
      })

      expect(result).toContain('2 task(s)')

      const list = listChangesTool(createMockDefine(), ctx) as unknown as { handler: ListHandler }
      const listing = await list.handler()
      expect(listing).toContain('Add dark mode')
      expect(listing).toContain('0/2 tasks')
    })
  })

  describe('update_change_task', () => {
    it('marks a task done by its 1-based position', async () => {
      const ctx = context()
      const propose = proposeChangeTool(createMockDefine(), ctx) as unknown as {
        handler: ProposeHandler
      }
      const update = updateChangeTaskTool(createMockDefine(), ctx) as unknown as {
        handler: UpdateTaskHandler
      }
      const list = listChangesTool(createMockDefine(), ctx) as unknown as { handler: ListHandler }

      const created = await propose.handler({
        title: 'Fix bug',
        why: 'It is broken.',
        tasks: ['Find it', 'Fix it']
      })
      const slug = /Created change "([^"]+)"/.exec(created)?.[1]
      expect(slug).toBeTruthy()

      const result = await update.handler({ slug: slug!, taskNumber: 1, done: true })
      expect(result).toContain('marked done')

      const updatedListing = await list.handler()
      expect(updatedListing).toContain('1/2 tasks')
    })

    it('reports an error to the model for an unknown change slug', async () => {
      const ctx = context()
      const update = updateChangeTaskTool(createMockDefine(), ctx) as unknown as {
        handler: UpdateTaskHandler
      }

      const result = await update.handler({ slug: 'does-not-exist', taskNumber: 1, done: true })
      expect(result).toContain('No change named')
    })
  })

  describe('archive_change', () => {
    it('removes an archived change from the active list', async () => {
      const ctx = context()
      const propose = proposeChangeTool(createMockDefine(), ctx) as unknown as {
        handler: ProposeHandler
      }
      const archive = archiveChangeTool(createMockDefine(), ctx) as unknown as {
        handler: ArchiveHandler
      }
      const list = listChangesTool(createMockDefine(), ctx) as unknown as { handler: ListHandler }

      await propose.handler({ title: 'Cleanup', why: 'Tech debt.', tasks: ['Remove dead code'] })
      const listing = await list.handler()
      const [slug] = listing.split(' [')

      const result = await archive.handler({ slug })
      expect(result).toContain('Archived')

      const afterArchive = await list.handler()
      expect(afterArchive).toBe('No active changes proposed yet.')
    })
  })

  describe('list_changes', () => {
    it('reports when there are no active changes', async () => {
      const ctx = context()
      const list = listChangesTool(createMockDefine(), ctx) as unknown as { handler: ListHandler }

      const result = await list.handler()
      expect(result).toBe('No active changes proposed yet.')
    })
  })
})
