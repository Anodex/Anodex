import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { availableTools, listToolNames, toolIsAvailable } from '../toolAvailability'
import { editFileTool, writeFileTool } from '../mutationTools'
import { readFileTool } from '../fileTools'
import { describeEmptySearchResult } from '../commandGuidance'
import { createMockContext, createMockDefine } from './test-helpers'

describe('toolIsAvailable', () => {
  const ctx = (
    enabledTools: Set<string> | null,
    disabledTools: Set<string> = new Set()
  ): { enabledTools: Set<string> | null; disabledTools: Set<string> } => ({
    enabledTools,
    disabledTools
  })

  it('allows anything when there is no allow-list', () => {
    expect(toolIsAvailable(ctx(null), 'replace_lines')).toBe(true)
  })

  it('honours the allow-list an agent run sets', () => {
    expect(toolIsAvailable(ctx(new Set(['read_file'])), 'replace_lines')).toBe(false)
    expect(toolIsAvailable(ctx(new Set(['read_file'])), 'read_file')).toBe(true)
  })

  it('honours a tool the user switched off, allow-list or not', () => {
    expect(toolIsAvailable(ctx(null, new Set(['replace_lines'])), 'replace_lines')).toBe(false)
    expect(
      toolIsAvailable(ctx(new Set(['replace_lines']), new Set(['replace_lines'])), 'replace_lines')
    ).toBe(false)
  })

  it('filters a list while keeping its order', () => {
    expect(availableTools(ctx(new Set(['b', 'a'])), ['a', 'b', 'c'])).toEqual(['a', 'b'])
  })

  it('joins names into a readable clause', () => {
    expect(listToolNames([])).toBe('')
    expect(listToolNames(['a'])).toBe('a')
    expect(listToolNames(['a', 'b'])).toBe('a or b')
    expect(listToolNames(['a', 'b', 'c'])).toBe('a, b or c')
  })
})

/**
 * Guidance may only name tools the run can actually call.
 *
 * This has gone wrong twice. A guard once refused the very tool its own
 * message told the model to use; then `edit_file` spent twenty-two failures
 * across eleven benchmark runs telling a model to fall back to `replace_lines`
 * when that run's tool list did not include it. Both are invisible in a
 * transcript — a failed edit followed by a re-read reads as ordinary model
 * error — so they are pinned here instead.
 */
describe('guidance names only tools the run has', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-availability-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  /** The nine basics a build-style agent run is given, with no partial-edit tools. */
  const BASICS = new Set([
    'list_directory',
    'read_file',
    'read_file_range',
    'read_multiple_files',
    'search_files',
    'find_files',
    'write_file',
    'edit_file',
    'run_command'
  ])

  const editHandler = (ctx: ReturnType<typeof createMockContext>) =>
    editFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; oldText: string; newText: string }) => Promise<string>
    }

  it('offers replace_lines for an unmatched edit when the run has it', async () => {
    await writeFile(join(workspace, 'a.ts'), 'const alpha = 1\nconst beta = 2\n')
    const ctx = createMockContext(workspace)
    const error = await editHandler(ctx)
      .handler({ path: 'a.ts', oldText: 'const gamma = 3', newText: 'x' })
      .catch((thrown: Error) => thrown)

    expect(String(error)).toContain('replace_lines')
  })

  it('does not offer replace_lines when the run cannot call it', async () => {
    await writeFile(join(workspace, 'a.ts'), 'const alpha = 1\nconst beta = 2\n')
    const ctx = { ...createMockContext(workspace), enabledTools: BASICS }
    const error = await editHandler(ctx)
      .handler({ path: 'a.ts', oldText: 'const gamma = 3', newText: 'x' })
      .catch((thrown: Error) => thrown)

    expect(String(error)).not.toContain('replace_lines')
    // It still has to say something useful.
    expect(String(error)).toMatch(/read that part of the file again/)
  })

  it('does not offer replace_lines in a near-miss hint either', async () => {
    await writeFile(join(workspace, 'a.ts'), 'const alphabetical = 1\nconst beta = 2\n')
    const ctx = { ...createMockContext(workspace), enabledTools: BASICS }
    // The hint anchors on the first line, so that one has to match verbatim
    // while the rest does not — which is exactly the case it exists for.
    const error = await editHandler(ctx)
      .handler({
        path: 'a.ts',
        oldText: 'const alphabetical = 1\nconst gamma = 3',
        newText: 'x'
      })
      .catch((thrown: Error) => thrown)

    // The hint fires (it found the line) but names no tool the run lacks.
    expect(String(error)).toContain('line 1')
    expect(String(error)).not.toContain('replace_lines')
  })

  it('does not offer partial-edit tools when refusing a destructive overwrite', async () => {
    const big = 'const value = 1\n'.repeat(400)
    await writeFile(join(workspace, 'big.ts'), big)
    const ctx = { ...createMockContext(workspace), enabledTools: BASICS }
    const tool = writeFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; content: string }) => Promise<string>
    }
    const error = await tool
      .handler({ path: 'big.ts', content: 'const value = 1\n' })
      .catch((thrown: Error) => thrown)

    expect(String(error)).toContain('discarding most of the file')
    expect(String(error)).not.toContain('replace_lines')
    expect(String(error)).not.toContain('patch_file')
  })

  it('does not point a too-large file at code_outline when the run lacks it', async () => {
    // Comfortably past the 60 KB ceiling read_file will return in full.
    await writeFile(join(workspace, 'huge.txt'), 'x'.repeat(200_000))
    const ctx = { ...createMockContext(workspace), enabledTools: BASICS }
    const tool = readFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }
    const result = await tool.handler({ path: 'huge.txt' })

    expect(result).toContain('Too large')
    expect(result).not.toContain('code_outline')
    // search_files and read_file_range are in this run's list, so it may name them.
    expect(result).toContain('read_file_range')
  })

  it('drops the confirm-with clause when no search tool is available', () => {
    const withTools = describeEmptySearchResult('grep -rn foo .', '', false, [
      'search_files',
      'code_outline'
    ])
    expect(withTools).toContain('search_files')

    const without = describeEmptySearchResult('grep -rn foo .', '', false, [])
    expect(without).not.toContain('search_files')
    expect(without).toContain('a simpler literal pattern')
  })
})
