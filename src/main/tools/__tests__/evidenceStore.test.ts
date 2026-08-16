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
import { recallEvidenceTool } from '../evidenceTools'
import { readFileRangeTool, readFileTool } from '../fileTools'
import { runReadTool } from '../helpers'
import {
  captureCalls,
  createMockContext,
  createMockDefine,
  splitEvidenceMarker
} from './test-helpers'

const BODY = 'line one\nline two with needle\nline three\n'.repeat(40)

describe('TurnEvidenceStore', () => {
  it('stores a result and describes it in one recallable line', () => {
    const store = createTurnEvidenceStore()

    const record = store.record({ tool: 'read_file', label: 'Read a.ts', body: BODY })

    expect(record?.id).toBe('E1')
    const descriptor = store.descriptor('E1')
    expect(descriptor).toContain('read_file')
    expect(descriptor).toContain('Read a.ts')
    // Steers to a targeted recall: the bare id invites paging a whole file back
    // into a window that could not hold it, which is what a live run did fifty
    // times over.
    expect(descriptor).toContain('recall_evidence("E1", match:')
    // The descriptor has to survive a round trip through the message array, so
    // the transports can collapse a result to it without a store reference.
    expect(evidenceDescriptorOf(withEvidenceMarker('body text', descriptor))).toBe(descriptor)
    expect(isEvidenceDescriptorOnly(descriptor)).toBe(true)
  })

  it('does not store a result too small to be worth the indirection', () => {
    const store = createTurnEvidenceStore()

    expect(store.record({ tool: 'get_file_info', label: 'Info a.ts', body: '12 bytes' })).toBeNull()
    expect(store.size).toBe(0)
  })

  it('pages a long result and reports where to continue', () => {
    const store = createTurnEvidenceStore()
    store.record({ tool: 'read_file', label: 'Read a.ts', body: BODY })

    const first = store.slice('E1', 0, 100)
    expect(first?.text).toBe(BODY.slice(0, 100))
    expect(first?.nextOffset).toBe(100)

    const last = store.slice('E1', BODY.length - 10, 100)
    expect(last?.nextOffset).toBeNull()
  })

  it('finds matching lines with their offsets instead of paging', () => {
    const store = createTurnEvidenceStore()
    store.record({ tool: 'read_file', label: 'Read a.ts', body: BODY })

    const found = store.findLines('E1', 'needle', 2_000)

    expect(found).toContain('line two with needle')
    expect(found).toMatch(/@\d+\t/)
  })

  it('recovers an id a weaker model wrapped in punctuation or lowercased', () => {
    const store = createTurnEvidenceStore()
    store.record({ tool: 'read_file', label: 'Read a.ts', body: BODY })

    expect(store.get('"E1"')?.id).toBe('E1')
    expect(store.get('e1')?.id).toBe('E1')
    expect(store.get('E2')).toBeUndefined()
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

  it('matches stored labels by path so a repeat read can be redirected', () => {
    const store = createTurnEvidenceStore()
    store.record({ tool: 'read_file_range', label: 'Read src/app.ts lines 1-200', body: BODY })
    store.record({ tool: 'read_file_range', label: 'Read src/other.ts lines 1-200', body: BODY })
    store.record({ tool: 'read_file_range', label: 'Read src/app.ts lines 201-400', body: BODY })

    // Newest first: the most recent read of that path is the most useful one to
    // point at.
    expect(store.idsMentioning('src/app.ts')).toEqual(['E3', 'E1'])
    expect(store.idsMentioning('src/missing.ts')).toEqual([])
  })

  it('names a collapsed archive without losing the way back to it', () => {
    expect(collapsedEvidenceNotice(24)).toContain('24 earlier result(s) still stored')
    expect(collapsedEvidenceNotice(24)).toContain('recall_evidence()')
    expect(isEvidenceDescriptorOnly(collapsedEvidenceNotice(24))).toBe(false)
  })
})

describe('tool results carry a durable handle', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-evidence-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('stores the whole result even when the context-facing copy is truncated', async () => {
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
    // The point of the store: what the model was shown is a fraction of what
    // remains recoverable.
    expect(body.length).toBeLessThan(full.length)
    expect(ctx.ledger.evidence.get('E1')?.body).toBe(full)
  })

  it('keeps the whole result and its handle when it already fits', async () => {
    const content = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n')
    await writeFile(join(workspace, 'a.txt'), content)
    const ctx = createMockContext(workspace)
    const tool = readFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }

    const [body, marker] = splitEvidenceMarker(await tool.handler({ path: 'a.txt' }))

    expect(body).toBe(content)
    expect(marker).toContain('recall_evidence("E1"')
  })

  it('keeps the handle inside the result budget rather than on top of it', async () => {
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

  it('does not store a refusal as if it were evidence', async () => {
    const content = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n')
    await writeFile(join(workspace, 'a.txt'), content)
    const ctx = createMockContext(workspace)
    ctx.ledger.reads.recordRange(join(workspace, 'a.txt'), 1, 60)
    const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; startLine: number; endLine: number }) => Promise<string>
    }

    await tool.handler({ path: 'a.txt', startLine: 1, endLine: 20 })

    expect(ctx.ledger.evidence.size).toBe(0)
  })
})

describe('read tools redirect a repeat to the stored copy', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-redirect-'))
    await writeFile(
      join(workspace, 'a.txt'),
      Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n')
    )
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('points a repeated range read at recall_evidence instead of dead-ending', async () => {
    const ctx = createMockContext(workspace)
    const tool = readFileRangeTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string; startLine: number; endLine: number }) => Promise<string>
    }
    await tool.handler({ path: 'a.txt', startLine: 1, endLine: 60 })

    const repeat = await tool.handler({ path: 'a.txt', startLine: 1, endLine: 20 })

    expect(repeat).toContain('recall_evidence("E1")')
    // The old behaviour told the model to try something else and left it with
    // no way to see content it had genuinely lost. See
    // `docs/CONTEXT_SYSTEM_ROOT_CAUSE.md` §1.
    expect(repeat).not.toContain('Try a different range or file instead')
  })

  it('points a repeated whole-file read at the stored copy too', async () => {
    const ctx = createMockContext(workspace)
    const tool = readFileTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { path: string }) => Promise<string>
    }
    await tool.handler({ path: 'a.txt' })

    const repeat = await tool.handler({ path: 'a.txt' })

    expect(repeat).toContain('recall_evidence("E1")')
  })
})

describe('recall_evidence', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-recall-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  function recallTool(ctx: ReturnType<typeof createMockContext>): {
    handler: (args: { id?: string; offset?: number; match?: string }) => Promise<string>
  } {
    return recallEvidenceTool(createMockDefine(), ctx)
  }

  it('serves back a result whose text has left the conversation', async () => {
    const ctx = createMockContext(workspace)
    ctx.ledger.evidence.record({ tool: 'read_file', label: 'Read a.ts', body: BODY })

    const result = await recallTool(ctx).handler({ id: 'E1' })

    expect(result).toContain('line two with needle')
  })

  it('jumps straight to matching lines when given a match', async () => {
    const ctx = createMockContext(workspace)
    ctx.ledger.evidence.record({ tool: 'read_file', label: 'Read a.ts', body: BODY })

    const result = await recallTool(ctx).handler({ id: 'E1', match: 'needle' })

    expect(result).toContain('line two with needle')
    expect(result).not.toContain('line three')
  })

  it('lists the catalogue when asked for an id that does not exist', async () => {
    const ctx = createMockContext(workspace)
    ctx.ledger.evidence.record({ tool: 'read_file', label: 'Read a.ts', body: BODY })

    const result = await recallTool(ctx).handler({ id: 'E9' })

    expect(result).toContain('No stored result has id "E9"')
    expect(result).toContain('E1')
  })

  it('never returns more than the turn’s measured result budget allows', async () => {
    const ctx = createMockContext(workspace)
    ctx.modelResultBudget.current = {
      contextSizeTokens: 16_384,
      inputLimitTokens: 15_872,
      fixedTokens: 13_000,
      minimumReplyReserveTokens: 1_024,
      maxTokensPerResult: 200
    }
    ctx.ledger.evidence.record({ tool: 'read_file', label: 'Read a.ts', body: BODY })

    const result = await recallTool(ctx).handler({ id: 'E1' })

    // Recalling must relieve context pressure, not become a second way to
    // refill the window it was called to free.
    expect(result.length).toBeLessThan(BODY.length)
    expect(result).toContain('recall_evidence("E1"')
  })

  it('does not count as task progress', async () => {
    const ctx = createMockContext(workspace)
    ctx.ledger.evidence.record({ tool: 'read_file', label: 'Read a.ts', body: BODY })

    await recallTool(ctx).handler({ id: 'E1' })

    // Reading back something already gathered cannot satisfy `finish_goal`'s
    // evidence gate — see `TurnProgress`.
    expect(ctx.progress.madeChange).toBe(false)
  })
})

describe('recall does not feed itself', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-recall-loop-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('never stores a recall result as new evidence', async () => {
    const ctx = createMockContext(workspace)
    ctx.ledger.evidence.record({ tool: 'read_file', label: 'Read a.ts', body: BODY })
    const tool = recallEvidenceTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { id?: string }) => Promise<string>
    }

    for (let i = 0; i < 5; i++) await tool.handler({ id: 'E1' })

    // The live failure: every recall minted a copy of the record it had just
    // read, the catalogue grew by one entry per recall, and a model looking at a
    // lengthening list of handles kept recalling. One turn made 50 of them and
    // zero writes.
    expect(ctx.ledger.evidence.size).toBe(1)
  })

  it('does not let recalling buy the turn more room to keep recalling', async () => {
    const ctx = createMockContext(workspace)
    ctx.ledger.evidence.record({ tool: 'read_file', label: 'Read a.ts', body: BODY })
    const { calls, emit } = captureCalls()
    const recall = recallEvidenceTool(createMockDefine(), { ...ctx, emit }) as unknown as {
      handler: (args: { id?: string }) => Promise<string>
    }

    await recall.handler({ id: 'E1' })

    // `madeProgress: false` is what keeps `runBoundedChatGeneration` from
    // treating a recall-only cycle as progress worth another cycle, and keeps
    // `finish_goal`'s evidence gate from accepting it as work.
    const success = calls.find((call) => call.status === 'success')
    expect(success?.madeProgress).toBe(false)
    expect(ctx.progress.madeChange).toBe(false)
  })
})
