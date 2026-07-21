import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReadCoverageTracker } from '../readCoverage'
import { describeUnverifiedPathClaims, findUnverifiedPathClaims } from '../pathClaimVerification'

describe('findUnverifiedPathClaims', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-path-claims-'))
    await mkdir(join(workspace, 'src', 'main'), { recursive: true })
    await writeFile(join(workspace, 'src', 'main', 'index.ts'), 'export {}')
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('returns nothing when there is no workspace to verify against', async () => {
    const tracker = new ReadCoverageTracker()
    const issues = await findUnverifiedPathClaims(
      'See `src/main/index.ts` for details.',
      null,
      tracker
    )
    expect(issues).toEqual([])
  })

  it('flags a path that does not exist in the workspace', async () => {
    const tracker = new ReadCoverageTracker()
    const issues = await findUnverifiedPathClaims(
      'The IPC layer lives in `src/main/ipc/tool.handlers.ts`.',
      workspace,
      tracker
    )
    expect(issues).toEqual([{ path: 'src/main/ipc/tool.handlers.ts', reason: 'not-found' }])
  })

  it('flags a real path that no tool call actually read this task', async () => {
    const tracker = new ReadCoverageTracker()
    const issues = await findUnverifiedPathClaims(
      'Covered in `src/main/index.ts`.',
      workspace,
      tracker
    )
    expect(issues).toEqual([{ path: 'src/main/index.ts', reason: 'not-inspected' }])
  })

  it('does not flag a path that was actually read this task', async () => {
    const tracker = new ReadCoverageTracker()
    tracker.recordRange(join(workspace, 'src', 'main', 'index.ts'), 1, 50)
    const issues = await findUnverifiedPathClaims(
      'Covered in `src/main/index.ts`.',
      workspace,
      tracker
    )
    expect(issues).toEqual([])
  })

  it('does not flag a path that was read in full this task', async () => {
    const tracker = new ReadCoverageTracker()
    tracker.recordFullFile(join(workspace, 'src', 'main', 'index.ts'))
    const issues = await findUnverifiedPathClaims(
      'Covered in `src/main/index.ts`.',
      workspace,
      tracker
    )
    expect(issues).toEqual([])
  })

  it('ignores a path that escapes the workspace rather than flagging it', async () => {
    const tracker = new ReadCoverageTracker()
    const issues = await findUnverifiedPathClaims(
      'See `../../etc/passwd.ts` for reference.',
      workspace,
      tracker
    )
    expect(issues).toEqual([])
  })

  it('deduplicates repeated mentions of the same unverified path', async () => {
    const tracker = new ReadCoverageTracker()
    const issues = await findUnverifiedPathClaims(
      'Both `src/main/ipc/tool.handlers.ts` and `src/main/ipc/tool.handlers.ts` again.',
      workspace,
      tracker
    )
    expect(issues).toHaveLength(1)
  })

  it('skips a directory match rather than flagging it as an unread file', async () => {
    await mkdir(join(workspace, 'src', 'main', 'fake.dir.ts'), { recursive: true })
    const tracker = new ReadCoverageTracker()
    const issues = await findUnverifiedPathClaims(
      'See `src/main/fake.dir.ts` for structure.',
      workspace,
      tracker
    )
    expect(issues).toEqual([])
  })
})

describe('describeUnverifiedPathClaims', () => {
  it('returns null when there is nothing to flag', () => {
    expect(describeUnverifiedPathClaims([])).toBeNull()
  })

  it('separates not-found and not-inspected paths into distinct lines', () => {
    const note = describeUnverifiedPathClaims([
      { path: 'a/fake.ts', reason: 'not-found' },
      { path: 'b/real.ts', reason: 'not-inspected' }
    ])
    expect(note).toContain('a/fake.ts')
    expect(note).toContain('b/real.ts')
    expect(note).toContain('likely fabricated or misspelled')
    expect(note).toContain('no tool call actually read them this task')
  })
})
