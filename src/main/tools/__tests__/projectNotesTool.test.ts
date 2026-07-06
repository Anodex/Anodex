import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendNote,
  PROJECT_NOTES_FILENAME,
  todayHeading,
  updateProjectNotesTool
} from '../projectNotesTool'
import {
  captureCalls,
  captureConfirmations,
  createMockContext,
  createMockDefine
} from './test-helpers'

describe('appendNote', () => {
  const heading = '## 2026-07-05'

  it("creates a new file with a header and today's heading when empty", () => {
    const result = appendNote('', 'Uses ESM throughout.', heading)

    expect(result).toContain('# Anodex Notes')
    expect(result).toContain(heading)
    expect(result).toContain('- Uses ESM throughout.')
  })

  it('adds a new dated section when today has none yet', () => {
    const existing = '# Anodex Notes\n\n## 2026-07-01\n- Older note.\n'
    const result = appendNote(existing, 'New note.', heading)

    expect(result).toContain('## 2026-07-01\n- Older note.')
    expect(result).toContain(`${heading}\n- New note.`)
  })

  it('appends under an existing same-day heading, after prior bullets', () => {
    const existing = `# Anodex Notes\n\n${heading}\n- First note.\n`
    const result = appendNote(existing, 'Second note.', heading)

    const lines = result.trim().split('\n')
    expect(lines).toEqual(['# Anodex Notes', '', heading, '- First note.', '- Second note.'])
  })

  it('inserts before a later heading rather than at the very end of the file', () => {
    const existing = `# Anodex Notes\n\n${heading}\n- First note.\n\n## 2026-07-06\n- Future note.\n`
    const result = appendNote(existing, 'Second note.', heading)

    const lines = result.trim().split('\n')
    expect(lines.indexOf('- Second note.')).toBeLessThan(lines.indexOf('## 2026-07-06'))
  })

  it('trims whitespace from the note text', () => {
    const result = appendNote('', '  spaced out note  ', heading)
    expect(result).toContain('- spaced out note')
  })
})

describe('todayHeading', () => {
  it('formats as ## YYYY-MM-DD', () => {
    expect(todayHeading(new Date(2026, 0, 5))).toBe('## 2026-01-05')
    expect(todayHeading(new Date(2026, 11, 31))).toBe('## 2026-12-31')
  })
})

describe('update_project_notes tool', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-notes-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('creates ANODEX.md on first use, after approval', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext(workspace), confirm }
    const tool = updateProjectNotesTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { note: string }) => Promise<string>
    }

    const result = await tool.handler({ note: 'The build uses Vite, not webpack.' })

    expect(result).toContain(PROJECT_NOTES_FILENAME)
    expect(requests).toHaveLength(1)
    const content = await readFile(join(workspace, PROJECT_NOTES_FILENAME), 'utf-8')
    expect(content).toContain('The build uses Vite, not webpack.')
  })

  it('appends a second note under the same day heading', async () => {
    const ctx = {
      ...createMockContext(workspace),
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = updateProjectNotesTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { note: string }) => Promise<string>
    }

    await tool.handler({ note: 'First note.' })
    await tool.handler({ note: 'Second note.' })

    const content = await readFile(join(workspace, PROJECT_NOTES_FILENAME), 'utf-8')
    const headingCount = content.split(todayHeading()).length - 1
    expect(headingCount).toBe(1)
    expect(content).toContain('First note.')
    expect(content).toContain('Second note.')
  })

  it('captures a diff for the UI', async () => {
    const capture = captureCalls()
    const ctx = {
      ...createMockContext(workspace),
      emit: capture.emit,
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = updateProjectNotesTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { note: string }) => Promise<string>
    }

    await tool.handler({ note: 'A note.' })

    const success = capture.calls.find((c) => c.status === 'success')
    expect(success?.diff?.before).toBe('')
    expect(success?.diff?.after).toContain('A note.')
  })

  it('rejects an empty note', async () => {
    const ctx = {
      ...createMockContext(workspace),
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = updateProjectNotesTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { note: string }) => Promise<string>
    }

    const result = await tool.handler({ note: '   ' })

    expect(result).toContain('empty')
  })
})
