import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  collapsedEvidenceNotice,
  createTurnEvidenceStore,
  evidenceDescriptorOf,
  isEvidenceDescriptorOnly,
  withEvidenceMarker
} from '../evidenceStore'
import { readFileRangeTool, readFileTool } from '../fileTools'
import { runReadTool } from '../helpers'
import { createMockContext, createMockDefine, splitEvidenceMarker } from './test-helpers'

const BODY = 'line one\nline two with needle\nline three\n'.repeat(40)

describe('TurnEvidenceStore', () => {
  it('records a result and describes it in one line', () => {
    const store = createTurnEvidenceStore()

    const record = store.record({ tool: 'read_file', label: 'Read a.ts', body: BODY })

    expect(record?.id).toBe('E1')
    const descriptor = store.descriptor(record!)
    expect(descriptor).toContain('read_file')
    expect(descriptor).toContain('Read a.ts')
    // The descriptor is a record of the call, not a way back to its bytes: the
    // way back is reading again, which the ledger now allows.
    expect(descriptor).toContain('read it again')
    // The descriptor has to survive a round trip through the message array, so
    // the transports can collapse a result to it without a store reference.
    expect(evidenceDescriptorOf(withEvidenceMarker('body text', descriptor))).toBe(descriptor)
    expect(isEvidenceDescriptorOnly(descriptor)).toBe(true)
  })

  it('does not record a result too small to be worth a descriptor', () => {
    const store = createTurnEvidenceStore()

    expect(store.record({ tool: 'get_file_info', label: 'Info a.ts', body: '12 bytes' })).toBeNull()
    expect(store.index()).toContain('Nothing gathered yet')
  })

  it('keeps metadata only — never the result body', () => {
    const store = createTurnEvidenceStore()

    const record = store.record({ tool: 'read_file', label: 'Read a.ts', body: BODY })

    // Holding bodies existed to serve them back through `recall_evidence`.
    // With that tool retired nothing reads them, and a long turn would carry
    // megabytes of strings for a character count.
    expect(record).not.toHaveProperty('body')
    expect(record?.chars).toBe(BODY.length)
  })

  it('lists what a task has gathered, newest last', () => {
    const store = createTurnEvidenceStore()
    store.record({ tool: 'read_file', label: 'Read a.ts', body: BODY })
    store.record({ tool: 'search_files', label: 'Search "needle"', body: BODY })

    const index = store.index()

    expect(index).toContain('E1')
    expect(index).toContain('E2')
    expect(index.indexOf('E1')).toBeLessThan(index.indexOf('E2'))
  })

  it('names a collapsed archive without pretending it can be read back', () => {
    expect(collapsedEvidenceNotice(24)).toContain('24 earlier result(s)')
    expect(collapsedEvidenceNotice(24)).not.toContain('recall')
    expect(isEvidenceDescriptorOnly(collapsedEvidenceNotice(24))).toBe(false)
  })
})

describe('tool results carry a descriptor', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-evidence-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('reports the whole result size even when the context-facing copy is truncated', async () => {
    const full = 'z'.repeat(20_000)
    const ctx = createMockContext(workspace)
    ctx.modelResultBudget.current = {
      contextSizeTokens: 16_384,
      inputLimitTokens: 15_872,
      fixedTokens: 13_000,
      minimumReplyReserveTokens: 1_024,
      maxTokensPerResult: 400
    }

    const result = await runReadTool(ctx, {
      name: 'search_files',
      kind: 'read',
      title: 'Search "z"',
      run: () => Promise.resolve({ modelResult: full })
    })
    const [body, marker] = splitEvidenceMarker(result)

    expect(marker).not.toBeNull()
    // The record is taken before truncation, so the descriptor tells the model
    // how much of the result it is *not* looking at.
    expect(body.length).toBeLessThan(full.length)
    expect(marker).toContain(full.length.toLocaleString('en-US'))
  })

  it('keeps the whole result and its descriptor when it already fits', async () => {
    const content = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n')
    await writeFile(join(workspace, 'a.txt'), content)
    const ctx = createMockContext(workspace)
    const tool = readFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    const [body, marker] = splitEvidenceMarker(await tool.handler({ path: 'a.txt' }))

    expect(body).toBe(content)
    expect(marker).toContain('[evidence E1 ·')
  })

  it('keeps the descriptor inside the result budget rather than on top of it', async () => {
    const content = 'x'.repeat(20_000)
    await writeFile(join(workspace, 'a.txt'), content)
    const ctx = createMockContext(workspace)
    ctx.modelResultBudget.current = {
      contextSizeTokens: 16_384,
      inputLimitTokens: 15_872,
      fixedTokens: 12_000,
      minimumReplyReserveTokens: 1_024,
      maxTokensPerResult: 500
    }
    const tool = readFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    const result = await tool.handler({ path: 'a.txt' })

    // 500 tokens × the conservative 3 chars/token in `modelResultCharBudget`.
    expect(result.length).toBeLessThanOrEqual(1_500)
  })

  it('does not record a refusal as if it were evidence', async () => {
    const content = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n')
    await writeFile(join(workspace, 'a.txt'), content)
    const ctx = createMockContext(workspace)
    ctx.ledger.reads.recordRange(join(workspace, 'a.txt'), 1, 60)
    const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; startLine: number; endLine: number }) => Promise<string>
    }

    await tool.handler({ path: 'a.txt', startLine: 1, endLine: 20 })

    expect(ctx.ledger.evidence.index()).toContain('Nothing gathered yet')
  })
})

describe('a repeated read runs again', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-reread-'))
    await writeFile(
      join(workspace, 'a.txt'),
      Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n')
    )
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('serves a repeated whole-file read again rather than pointing at a copy', async () => {
    const ctx = createMockContext(workspace)
    const tool = readFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }
    await tool.handler({ path: 'a.txt' })

    const repeat = await tool.handler({ path: 'a.txt' })

    // Any stored copy is by definition the older one. Handing that back is how
    // a live run ended up editing against line numbers that had already moved.
    expect(repeat).toContain('line 1')
  })
})

describe('a trimmed descriptor carries the shape of what it replaced', () => {
  // Measured across 45 stored runs: wasteful repeats hold at ~18.6 per 100 calls
  // and correlate with neither retained context (-0.15) nor run length (-0.11).
  // So the re-reads are not eviction pressure and keeping more does not help.
  // What is kept can at least be worth having.
  const PY_FILE =
    [
      'import math',
      '',
      'class Camera:',
      '    def __init__(self, position):',
      '        self.position = position',
      '',
      'def snapshot(cam):',
      '    return dict(position=cam.position)',
      ''
    ].join('\n') + 'x'.repeat(400)

  it('names the top-level declarations instead of only a byte count', () => {
    const store = createTurnEvidenceStore()
    const record = store.record({ tool: 'read_file', label: 'camera.py', body: PY_FILE })!

    const descriptor = store.descriptor(record)

    expect(descriptor).toContain('class Camera:')
    expect(descriptor).toContain('def snapshot(cam):')
    expect(descriptor).not.toContain('self.position = position') // indented body
  })

  it('stays far smaller than the body it stands in for', () => {
    // It is paid for out of the same result budget the body was, so a digest
    // growing towards the size of what it replaced would defeat its purpose.
    const store = createTurnEvidenceStore()
    const record = store.record({ tool: 'read_file', label: 'camera.py', body: PY_FILE })!

    expect(store.descriptor(record).length).toBeLessThan(PY_FILE.length / 2)
  })

  it('needs no list of languages it knows about', () => {
    // Top-level position is the signal, not a keyword vocabulary.
    const store = createTurnEvidenceStore()
    const go =
      ['package main', '', 'func main() {', '    println("hi")', '}'].join('\n') + 'y'.repeat(400)
    const record = store.record({ tool: 'read_file', label: 'main.go', body: go })!

    const descriptor = store.descriptor(record)

    expect(descriptor).toContain('package main')
    expect(descriptor).toContain('func main() {')
  })

  it('says nothing extra when there is no shape to report', () => {
    const store = createTurnEvidenceStore()
    const prose = 'x'.repeat(600)
    const record = store.record({ tool: 'fetch_url', label: 'page', body: prose })!

    expect(store.descriptor(record)).toContain('body trimmed')
    expect(store.descriptor(record)).not.toContain('shape:')
  })

  it('still tells the model the body is recoverable', () => {
    const store = createTurnEvidenceStore()
    const record = store.record({ tool: 'read_file', label: 'camera.py', body: PY_FILE })!

    expect(store.descriptor(record)).toContain('read it again')
  })
})
