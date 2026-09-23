import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findFilesTool, searchFilesTool } from '../fileTools'
import { createMockContext, createMockDefine } from './test-helpers'

/**
 * `path` is documented as a subdirectory, and a model reasonably reads it as
 * "where to look" and passes a file. That used to resolve to the file, call
 * `readdir` on it, throw ENOTDIR into a bare `catch`, and answer "No matches
 * found." — the worst available answer, because it is confidently wrong about
 * a file that does contain the text.
 */
describe('search_files with a path', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-search-path-'))
    await writeFile(join(workspace, 'engine.py'), 'def descend(self):\n    pass\n', 'utf-8')
    await mkdir(join(workspace, 'sub'), { recursive: true })
    await writeFile(join(workspace, 'sub', 'other.py'), 'descend elsewhere\n', 'utf-8')
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  const search = (): {
    handler: (args: { query: string; path?: string }) => Promise<string>
  } => searchFilesTool(createMockDefine(), createMockContext(workspace))

  it('searches the whole workspace when given no path', async () => {
    const out = await search().handler({ query: 'descend' })
    expect(out).toContain('engine.py')
    expect(out).toContain('other.py')
  })

  it('searches within a subdirectory', async () => {
    const out = await search().handler({ query: 'descend', path: 'sub' })
    expect(out).toContain('other.py')
    expect(out).not.toContain('engine.py')
  })

  it('searches a single file when the path names one', async () => {
    const out = await search().handler({ query: 'descend', path: 'engine.py' })
    expect(out).toContain('engine.py')
    expect(out).not.toContain('No matches found')
  })

  it('still says so honestly when that file really has no match', async () => {
    const out = await search().handler({ query: 'levitate', path: 'engine.py' })
    expect(out).toContain('No matches found')
  })

  it('reports a path that does not exist instead of answering "no matches"', async () => {
    // Read tools hand failures back as the result rather than rejecting, so
    // what matters is that the model is told the path was wrong — not that the
    // term was absent, which is what it used to be told.
    const out = await search().handler({ query: 'descend', path: 'nowhere' })
    expect(out).toContain('does not exist')
    expect(out).not.toContain('No matches found')
  })
})

/** `find_files` swallowed a bad path the same way, with the same consequence. */
describe('find_files with a path', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-find-path-'))
    await mkdir(join(workspace, 'sub'), { recursive: true })
    await writeFile(join(workspace, 'sub', 'engine.py'), 'x\n', 'utf-8')
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  const find = (): { handler: (args: { query: string; path?: string }) => Promise<string> } =>
    findFilesTool(createMockDefine(), createMockContext(workspace))

  it('finds a file under a real subdirectory', async () => {
    expect(await find().handler({ query: 'engine', path: 'sub' })).toContain('engine.py')
  })

  it('says the path is wrong rather than reporting nothing found', async () => {
    const out = await find().handler({ query: 'engine', path: 'nowhere' })
    expect(out).toContain('does not exist')
    expect(out).not.toContain('No matching paths found')
  })
})

/** The two cases the message has to keep apart. */
describe('a missing search path is explained, not implied', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-missing-path-'))
    await writeFile(join(workspace, 'engine.py'), 'descend\n', 'utf-8')
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('names the path the caller actually gave', async () => {
    const tool = searchFilesTool(createMockDefine(), createMockContext(workspace)) as unknown as {
      handler: (args: { query: string; path?: string }) => Promise<string>
    }
    const out = await tool.handler({ query: 'descend', path: 'src/engine.py' })
    expect(out).toContain('src/engine.py')
    expect(out).not.toContain('undefined')
  })

  it('says the workspace is gone rather than printing "undefined"', async () => {
    const ctx = createMockContext(workspace)
    await rm(workspace, { recursive: true, force: true })
    const tool = searchFilesTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { query: string; path?: string }) => Promise<string>
    }
    const out = await tool.handler({ query: 'descend' })
    expect(out).not.toContain('undefined')
    expect(out).toContain('no longer there')
  })

  it('searches a file the walk would have skipped for its extension', async () => {
    await writeFile(join(workspace, 'notes.weird'), 'descend here\n', 'utf-8')
    const tool = searchFilesTool(createMockDefine(), createMockContext(workspace)) as unknown as {
      handler: (args: { query: string; path?: string }) => Promise<string>
    }
    const out = await tool.handler({ query: 'descend', path: 'notes.weird' })
    expect(out).toContain('notes.weird')
  })
})
