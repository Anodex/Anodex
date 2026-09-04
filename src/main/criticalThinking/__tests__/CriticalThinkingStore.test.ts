import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CriticalThinkingRun } from '@shared/criticalThinking.types'
import {
  CriticalThinkingStore,
  normalizeCriticalThinkingRun,
  reconcileInterruptedCriticalThinkingRuns
} from '../CriticalThinkingStore'
import { DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY } from '../criticalThinkingResearchPolicy'

const temporaryDirectories: string[] = []

/**
 * Every store a test opened, so cleanup can let its writes finish.
 *
 * Loading a file that is not already in normalized form schedules a write that
 * nothing in the test awaits (see `CriticalThinkingStore.persist`). When the
 * test then ends, that write races the directory removal below and can recreate
 * `runs.json` while `rm` is walking the tree -- which surfaced as a macOS-only
 * CI failure, `ENOTEMPTY: directory not empty`, in a test that had nothing to do
 * with writing. Windows and Linux happened to win the race; nothing guaranteed
 * they would.
 *
 * Opening through `openStore` rather than asking each test to remember a flush,
 * so a test added later cannot reintroduce the race by omission.
 */
const openStores: CriticalThinkingStore[] = []

function openStore(directory: string): CriticalThinkingStore {
  const store = new CriticalThinkingStore()
  openStores.push(store)
  store.init(directory)
  return store
}

afterEach(async () => {
  // Rejections are the point of one test here ("reports a failed write"), and a
  // store left holding that error rethrows it on every later flush. Cleanup is
  // not the place to re-raise it.
  await Promise.all(openStores.splice(0).map((store) => store.flush().catch(() => {})))
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

function makeRun(status: CriticalThinkingRun['status']): CriticalThinkingRun {
  return {
    id: 'critical_test',
    question: 'Test question',
    status,
    provider: 'local',
    model: null,
    researchPolicy: { ...DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY },
    plan: null,
    report: '',
    sources: [],
    steps: [],
    currentStep: 0,
    evidenceCount: 0,
    activities: [],
    stats: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('reconcileInterruptedCriticalThinkingRuns', () => {
  it.each(['planning', 'researching', 'synthesizing', 'validating'] as const)(
    'makes an interrupted %s run resumable',
    (status) => {
      const [run] = reconcileInterruptedCriticalThinkingRuns([makeRun(status)])

      expect(run.status).toBe('partial')
      expect(run.lastError).toContain('app restarted')
    }
  )

  it.each(['needs-review', 'completed', 'partial', 'stopped', 'failed'] as const)(
    'leaves a %s run unchanged',
    (status) => {
      const original = makeRun(status)
      const [run] = reconcileInterruptedCriticalThinkingRuns([original])

      expect(run).toBe(original)
    }
  )
})

describe('normalizeCriticalThinkingRun', () => {
  it('adds pinned research defaults and round arrays to legacy runs', () => {
    const legacy = makeRun('partial')
    delete (legacy as { researchPolicy?: CriticalThinkingRun['researchPolicy'] }).researchPolicy
    legacy.steps = [
      {
        id: 'step_1',
        title: 'Legacy step',
        status: 'researching',
        attempts: 2,
        evidenceIds: ['artifact_1'],
        finding: 'Partial finding',
        uncertainties: ['One gap']
      } as CriticalThinkingRun['steps'][number]
    ]

    const normalized = normalizeCriticalThinkingRun(legacy)

    expect(normalized.researchPolicy).toEqual(DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY)
    expect(normalized.steps[0]).toMatchObject({
      id: 'step_1',
      attempts: 2,
      rounds: []
    })
  })

  it('preserves valid persisted limits while repairing invalid ones', () => {
    const run = makeRun('partial')
    run.researchPolicy = {
      ...run.researchPolicy,
      maxRoundsPerStep: 5,
      maxQueriesPerRound: 0
    }
    delete (run.researchPolicy as Partial<CriticalThinkingRun['researchPolicy']>)
      .maxVerifiedSourcesPerRun

    const normalized = normalizeCriticalThinkingRun(run)

    expect(normalized.researchPolicy.maxRoundsPerStep).toBe(5)
    expect(normalized.researchPolicy.maxQueriesPerRound).toBe(
      DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY.maxQueriesPerRound
    )
    expect(normalized.researchPolicy.maxVerifiedSourcesPerRun).toBe(
      DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY.maxVerifiedSourcesPerRun
    )
  })

  it('drops malformed legacy sources and bounds safe source metadata', () => {
    const run = makeRun('partial')
    run.sources = [
      null,
      { id: 'S1', title: 'Unsafe', url: 'javascript:alert(1)', verified: true },
      {
        id: 'S2',
        title: 'T'.repeat(400),
        url: 'https://safe.example/report',
        snippet: 'S'.repeat(700),
        verified: true
      }
    ] as unknown as CriticalThinkingRun['sources']

    const normalized = normalizeCriticalThinkingRun(run)

    expect(normalized.sources).toHaveLength(1)
    expect(normalized.sources[0]).toMatchObject({
      id: 'S2',
      url: 'https://safe.example/report',
      verified: true
    })
    expect(normalized.sources[0].title).toHaveLength(300)
    expect(normalized.sources[0].snippet).toHaveLength(500)
  })

  it('keeps the completion verdict and the contract issues across a reload', () => {
    // Both were recorded on the run but not rebuilt here, and this normaliser
    // reconstructs every diagnostic field by name on load -- so they survived
    // until the app next started and then silently vanished. Measured: a run's
    // blockers were read from the live file, and were gone from that same run
    // after the next launch, which is exactly when a stored diagnostic matters.
    const run = makeRun('partial')
    run.synthesisDiagnostics = {
      startedAt: 10,
      completedAt: 20,
      verifiedSourceCount: 3,
      evidencePacketChars: 2_000,
      evidenceCorpusChars: 0,
      strategy: 'single-pass',
      selectedStage: 'repair',
      chartAdded: false,
      completion: {
        usable: true,
        structurallyValid: false,
        limitedSteps: true,
        recoveredStage: false,
        repairStopped: false,
        otherSafetyIssueCount: 0,
        unverifiedQuotationCount: 21,
        unverifiedFigureCount: 0,
        citedSubstantiveBlockCount: 40,
        blockers: ['structurally-invalid', 'limited-steps']
      },
      attempts: [
        {
          stage: 'repair',
          contentChars: 100,
          content: 'x',
          safe: false,
          usable: true,
          valid: false,
          citedBlockCount: 40,
          issues: ['a citation issue'],
          contractIssues: ['The report is missing a limits, gaps, or open-questions section.']
        }
      ]
    } as unknown as CriticalThinkingRun['synthesisDiagnostics']

    const normalized = normalizeCriticalThinkingRun(run)

    expect(normalized.synthesisDiagnostics?.completion).toMatchObject({
      structurallyValid: false,
      limitedSteps: true,
      unverifiedQuotationCount: 21,
      blockers: ['structurally-invalid', 'limited-steps']
    })
    expect(normalized.synthesisDiagnostics?.attempts[0].contractIssues).toEqual([
      'The report is missing a limits, gaps, or open-questions section.'
    ])
  })

  it('leaves a run with no completion verdict alone', () => {
    const run = makeRun('partial')
    run.synthesisDiagnostics = {
      startedAt: 10,
      completedAt: 20,
      verifiedSourceCount: 1,
      evidencePacketChars: 10,
      evidenceCorpusChars: 0,
      strategy: 'single-pass',
      selectedStage: 'draft',
      chartAdded: false,
      attempts: []
    } as unknown as CriticalThinkingRun['synthesisDiagnostics']

    const normalized = normalizeCriticalThinkingRun(run)

    expect(normalized.synthesisDiagnostics?.completion).toBeUndefined()
  })

  it('normalizes bounded synthesis diagnostics without breaking legacy runs', () => {
    const legacy = normalizeCriticalThinkingRun(makeRun('partial'))
    expect(legacy.synthesisDiagnostics).toBeNull()

    const run = makeRun('partial')
    run.synthesisDiagnostics = {
      startedAt: 10,
      completedAt: 20,
      verifiedSourceCount: 3,
      evidencePacketChars: 2_000,
      evidenceCorpusChars: 0,
      strategy: 'hierarchical-recovery',
      selectedStage: 'hierarchical-report',
      chartAdded: false,
      attempts: [
        {
          stage: 'section',
          stepId: 'step_1',
          contentChars: 50_000,
          content: 'x'.repeat(50_000),
          stopReason: 'token-limit',
          safe: true,
          usable: true,
          valid: false,
          citedBlockCount: 2,
          issues: ['repair this']
        }
      ]
    }

    const normalized = normalizeCriticalThinkingRun(run)

    expect(normalized.synthesisDiagnostics).toMatchObject({
      strategy: 'hierarchical-recovery',
      selectedStage: 'hierarchical-report'
    })
    expect(normalized.synthesisDiagnostics?.attempts[0]).toMatchObject({
      stage: 'section',
      stepId: 'step_1',
      stopReason: 'token-limit',
      safe: true,
      citedBlockCount: 2
    })
    // runs.json is rewritten whole on every progress update and one
    // hierarchical run records ~19 attempts, so retained draft text is bounded
    // well below what a model can emit — including for drafts a previous build
    // persisted at the older, larger cap.
    expect(normalized.synthesisDiagnostics?.attempts[0].content).toHaveLength(12_000)
  })
})

describe('CriticalThinkingStore persistence', () => {
  it('coalesces progress updates and flushes the latest state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'anodex-critical-store-'))
    temporaryDirectories.push(directory)
    const store = openStore(directory)
    const run = store.create({ question: 'Original', provider: 'local', model: null })
    await store.flush()

    store.update(run.id, { status: 'researching', currentStep: 1 })
    store.update(run.id, { status: 'synthesizing', currentStep: 2 })
    await store.flush()

    const persisted: unknown = JSON.parse(await readFile(join(directory, 'runs.json'), 'utf8'))
    expect(persisted).toEqual([
      expect.objectContaining({ id: run.id, status: 'synthesizing', currentStep: 2 })
    ])
  })

  it('reports a failed write and retries the retained latest snapshot', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'anodex-critical-retry-'))
    temporaryDirectories.push(parent)
    const directory = join(parent, 'store')
    await mkdir(directory)
    const store = openStore(directory)
    await rm(directory, { recursive: true, force: true })

    const run = store.create({ question: 'Retry me', provider: 'local', model: null })
    await expect(store.flush()).rejects.toBeInstanceOf(Error)

    await mkdir(directory)
    await store.flush()
    const persisted: unknown = JSON.parse(await readFile(join(directory, 'runs.json'), 'utf8'))
    expect(persisted).toEqual([expect.objectContaining({ id: run.id, question: 'Retry me' })])
  })
})

describe('CriticalThinkingStore loading', () => {
  async function storeDirectory(contents?: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'anodex-critical-load-'))
    temporaryDirectories.push(directory)
    if (contents !== undefined) await writeFile(join(directory, 'runs.json'), contents, 'utf8')
    return directory
  }

  /**
   * The regression, and the fourth file in this codebase found doing it:
   * falling back to empty on an unreadable file without moving that file aside,
   * so the next write persists the empty list straight over it. Here that is
   * every past investigation and its report.
   */
  it('moves an unreadable run file aside instead of overwriting it', async () => {
    const truncated = '[{"id":"critical_old","question":"Half a fi'
    const directory = await storeDirectory(truncated)

    const store = openStore(directory)
    store.create({ question: 'New investigation', provider: 'local', model: null })
    await store.flush()

    expect(await readFile(join(directory, 'runs.json.corrupt'), 'utf8')).toBe(truncated)
    const persisted = JSON.parse(
      await readFile(join(directory, 'runs.json'), 'utf8')
    ) as CriticalThinkingRun[]
    expect(persisted.map((run) => run.question)).toEqual(['New investigation'])
  })

  it('still opens on an empty list so the feature is usable', async () => {
    const store = openStore(await storeDirectory('not json at all'))

    expect(store.list()).toEqual([])
  })

  /**
   * One entry with, say, a `plan.steps` that is not an array used to throw out
   * of the whole `map`, land in the catch, and start empty — one bad run cost
   * every other investigation in the file.
   */
  it('drops only the run it cannot read', async () => {
    const good = normalizeCriticalThinkingRun({ ...makeRun('completed'), id: 'critical_good' })
    const directory = await storeDirectory(
      JSON.stringify([{ id: 'critical_bad', plan: { steps: 'not-an-array' } }, good])
    )

    const store = openStore(directory)

    expect(store.list().map((run) => run.id)).toEqual(['critical_good'])
  })

  it('rewrites a file that is not already in its normalized form', async () => {
    // Compact JSON from an older build: same meaning, different bytes.
    const directory = await storeDirectory(JSON.stringify([makeRun('completed')]))
    const before = new Date(2020, 0, 1)
    await utimes(join(directory, 'runs.json'), before, before)

    const store = openStore(directory)
    await store.flush()

    expect((await stat(join(directory, 'runs.json'))).mtime.getTime()).toBeGreaterThan(
      before.getTime()
    )
  })

  /**
   * `normalizeCriticalThinkingRun` always returns a fresh object, so the old
   * `run !== parsed[index]` check was true for every run on every launch — a
   * guard that read as "only write when something changed" and rewrote the
   * whole file each time the app started.
   */
  it('leaves an already-normalized file alone on launch', async () => {
    const settled = normalizeCriticalThinkingRun(makeRun('completed'))
    const directory = await storeDirectory(JSON.stringify([settled], null, 2))
    const before = new Date(2020, 0, 1)
    await utimes(join(directory, 'runs.json'), before, before)

    const store = openStore(directory)
    await store.flush()

    expect((await stat(join(directory, 'runs.json'))).mtime.getTime()).toBe(before.getTime())
  })

  it('still repairs an interrupted run on the way in', async () => {
    const directory = await storeDirectory(
      JSON.stringify([normalizeCriticalThinkingRun(makeRun('researching'))], null, 2)
    )

    const store = openStore(directory)

    expect(store.list()[0]).toMatchObject({ status: 'partial' })
  })
})
