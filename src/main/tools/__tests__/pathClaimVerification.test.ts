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

  it('does not flag path-shaped fragments inside URLs', async () => {
    const tracker = new ReadCoverageTracker()
    const issues = await findUnverifiedPathClaims(
      'See https://github.com/Anodex/Anodex/blob/main/src/index.ts and ' +
        'https://docs.example.com/en/guide/setup.html for details.',
      workspace,
      tracker
    )
    expect(issues).toEqual([])
  })

  it('does not flag fragments of absolute unix-style paths', async () => {
    const tracker = new ReadCoverageTracker()
    const issues = await findUnverifiedPathClaims(
      'The library installs to /usr/lib/foo.so on Linux.',
      workspace,
      tracker
    )
    expect(issues).toEqual([])
  })

  it('still flags a workspace-relative path in ordinary surrounding prose', async () => {
    const tracker = new ReadCoverageTracker()
    const issues = await findUnverifiedPathClaims(
      'Fixed in src/main/missing.ts (see the diff), plus `src/main/index.ts`.',
      workspace,
      tracker
    )
    expect(issues).toEqual([
      { path: 'src/main/missing.ts', reason: 'not-found' },
      { path: 'src/main/index.ts', reason: 'not-inspected' }
    ])
  })

  it('does not flag a path this task successfully mutated, even one deleted from disk', async () => {
    const tracker = new ReadCoverageTracker()
    tracker.noteMutation(join(workspace, 'src', 'main', 'removed.ts'))
    const issues = await findUnverifiedPathClaims(
      'I deleted `src/main/removed.ts` as requested.',
      workspace,
      tracker
    )
    expect(issues).toEqual([])
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

describe('URLs are never mistaken for workspace paths', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-urlpath-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('does not flag a path fragment taken from a localhost URL', async () => {
    // Live false positive on an otherwise correct reply: `8000/index.html` was
    // extracted from `http://localhost:8000/index.html` and reported as
    // "likely fabricated". A false accusation on a correct answer costs more
    // than the check is worth.
    const issues = await findUnverifiedPathClaims(
      'Open `http://localhost:8000/index.html` and scroll to the sandbox.',
      workspace,
      new ReadCoverageTracker()
    )

    expect(issues).toEqual([])
  })

  it('ignores paths inside any scheme URL', async () => {
    const issues = await findUnverifiedPathClaims(
      'See https://github.com/acme/repo/blob/main/src/app.ts for the upstream version.',
      workspace,
      new ReadCoverageTracker()
    )

    expect(issues).toEqual([])
  })

  it('still flags a genuinely fabricated workspace path beside a URL', async () => {
    const issues = await findUnverifiedPathClaims(
      'Serving at http://localhost:8000/index.html; the bug is in `src/made-up.ts`.',
      workspace,
      new ReadCoverageTracker()
    )

    expect(issues).toEqual([{ path: 'src/made-up.ts', reason: 'not-found' }])
  })
})
