import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerationStopReason } from '@shared/chat.types'
import type {
  CriticalThinkingResearchPolicy,
  CriticalThinkingRun,
  CriticalThinkingSource,
  CriticalThinkingStepState
} from '@shared/criticalThinking.types'
import type { Plan } from '@shared/plan.types'
import type { ToolArtifact, WebFetchArtifactDraft } from '@shared/toolArtifacts.types'
import type { ToolCall } from '@shared/tools.types'
import type { RunGenerationIo, RunGenerationResult } from '../../chat/runGeneration'
import type { SearchResult } from '../../tools/search/types'

/**
 * Regression coverage for the bug reproduced in
 * docs/RUNTIME_RELIABILITY_RECOVERY_HANDOFF.md: a valid Critical Thinking
 * plan was discarded whenever generation happened to stop for a recoverable
 * reason (a token limit, a context-compaction limit) instead of a clean
 * completion. `mockPlanResponse` below is deliberately mechanism-adaptive —
 * it drives whichever planning transport the service currently uses (the
 * legacy native `write_plan` tool call, or the tool-free JSON phase that
 * replaced it) by inspecting `io.enabledTools`, so this same suite reproduces
 * the bug against the pre-fix code and verifies the fix without rewriting the
 * test in between.
 */

const EMPTY_STATS = { tokens: 0, durationMs: 0, tokensPerSecond: 0 }

const POLICY: CriticalThinkingResearchPolicy = {
  maxRoundsPerStep: 3,
  maxQueriesPerRound: 3,
  maxResultsPerQuery: 5,
  maxPagesPerRound: 4,
  searchConcurrency: 3,
  fetchConcurrency: 3,
  maxRoundsPerRun: 18,
  maxSearchesPerRun: 24,
  maxFetchesPerRun: 36,
  maxVerifiedSourcesPerRun: 40,
  maxRunMs: 3_600_000
}

const VALID_PLAN: Plan = {
  title: 'Bee and Wasp Sting Pain Research',
  steps: [
    { id: 'step-1', title: 'Compare venom composition across species', status: 'pending' },
    { id: 'step-2', title: 'Compare pain-scale ratings from primary studies', status: 'pending' },
    { id: 'step-3', title: 'Check allergic-reaction and repeat-sting evidence', status: 'pending' }
  ],
  updatedAt: 1
}

const mocks = vi.hoisted(() => ({
  runs: new Map<string, CriticalThinkingRun>(),
  artifacts: new Map<string, ToolArtifact[]>(),
  flushError: null as Error | null,
  nextId: 0,
  runGeneration: vi.fn<(request: unknown, io: RunGenerationIo) => Promise<RunGenerationResult>>(),
  search:
    vi.fn<(query: string, resultCount: number, signal?: AbortSignal) => Promise<SearchResult[]>>(),
  fetchUrlEvidence:
    vi.fn<(url: string, focus: string, signal?: AbortSignal) => Promise<WebFetchArtifactDraft>>()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '' }
}))

vi.mock('../../toastWindow', () => ({ showToastWindow: vi.fn() }))

vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: {
    get: () => ({
      tools: { enabled: true, disabledTools: [] },
      webSearch: { provider: 'duckduckgo', requireApproval: false },
      provider: {
        active: 'local',
        anthropic: { apiKey: '', model: '' },
        openai: { apiKey: '', model: '' }
      }
    })
  }
}))

vi.mock('../../llama/LlamaService', () => ({
  llamaService: {
    getState: () => ({
      status: 'ready',
      contextSize: 8_192,
      model: { id: 'test-model', name: 'Test Model' }
    })
  },
  GENERATION_IN_PROGRESS_ERROR: 'GENERATION_IN_PROGRESS'
}))

vi.mock('../../tools/search', () => ({
  createSearchProvider: () => ({ search: mocks.search })
}))

vi.mock('../../tools/webTools', () => ({
  fetchUrlEvidence: (...args: [string, string, AbortSignal]) => mocks.fetchUrlEvidence(...args)
}))

vi.mock('../../chat/runGeneration', () => ({
  runGeneration: mocks.runGeneration
}))

vi.mock('../CriticalThinkingStore', () => ({
  criticalThinkingStore: {
    create: () => {
      throw new Error('Test run creation goes through seedRun(), not the real store.')
    },
    get: (id: string) => mocks.runs.get(id),
    list: () => [...mocks.runs.values()],
    update: (id: string, patch: Partial<CriticalThinkingRun>) => {
      const current = mocks.runs.get(id)
      if (!current) throw new Error(`Critical Thinking run not found: ${id}`)
      const next = { ...current, ...patch, updatedAt: Date.now() }
      mocks.runs.set(id, next)
      return next
    },
    delete: (id: string) => {
      mocks.runs.delete(id)
    },
    flush: () => (mocks.flushError ? Promise.reject(mocks.flushError) : Promise.resolve())
  }
}))

vi.mock('../CriticalThinkingEvidenceStore', () => ({
  criticalThinkingEvidenceStore: {
    list: (runId: string) => mocks.artifacts.get(runId) ?? [],
    record: (runId: string, artifact: ToolArtifact) => {
      mocks.artifacts.set(runId, [...(mocks.artifacts.get(runId) ?? []), artifact])
      return true
    },
    delete: () => undefined,
    flush: () => Promise.resolve()
  }
}))

function seedRun(overrides: Partial<CriticalThinkingRun> = {}): CriticalThinkingRun {
  const now = Date.now()
  const run: CriticalThinkingRun = {
    id: overrides.id ?? `critical_test_${mocks.nextId++}`,
    question: 'Why do bee stings hurt so much, and how does it differ by species?',
    status: 'planning',
    provider: 'local',
    model: null,
    researchPolicy: { ...POLICY },
    plan: null,
    report: '',
    sources: [],
    steps: [],
    currentStep: 0,
    evidenceCount: 0,
    activities: [],
    stats: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
  mocks.runs.set(run.id, run)
  return run
}

/** Builds the plan JSON the tool-free phase expects from a `Plan` fixture. */
function planJson(plan: Plan): string {
  return JSON.stringify({ title: plan.title, steps: plan.steps.map((step) => step.title) })
}

interface MockPlanResponseOptions {
  plan?: Plan | null
  stopped: boolean
  stopReason?: GenerationStopReason
  content?: string
}

/**
 * Drives whichever planning transport is currently wired up: the legacy
 * native `write_plan` tool call (detected via `io.enabledTools`) or the
 * tool-free JSON phase. Only one of the two branches will ever actually run
 * for a given version of the service, but keeping both here means this test
 * file reproduces the bug pre-fix and verifies the fix post-fix without edits.
 */
function mockPlanResponse(options: MockPlanResponseOptions): void {
  mocks.runGeneration.mockImplementation((_request: unknown, io: RunGenerationIo) => {
    const usesNativeTool = Boolean(io.enabledTools && io.enabledTools.has('write_plan'))
    if (usesNativeTool && options.plan) {
      const call: ToolCall = {
        id: `call_${Math.random().toString(36).slice(2)}`,
        name: 'write_plan',
        kind: 'plan',
        title: `Plan: ${options.plan.title}`,
        status: 'success',
        plan: options.plan
      }
      io.onActivity?.(call)
    }
    const content = usesNativeTool
      ? ''
      : (options.content ?? (options.plan ? planJson(options.plan) : ''))
    return Promise.resolve({
      content,
      stats: EMPTY_STATS,
      stopped: options.stopped,
      stopReason: options.stopReason
    })
  })
}

/** Calls the service's private planning entry point directly and awaits full completion. */
async function runPlanningDirectly(run: CriticalThinkingRun): Promise<void> {
  const { criticalThinkingService } = await import('../CriticalThinkingService')
  const service = criticalThinkingService as unknown as {
    runPlanning: (run: CriticalThinkingRun) => Promise<void>
  }
  await service.runPlanning(run)
}

async function getStopHandle(): Promise<{ stop: (id: string) => void }> {
  const { criticalThinkingService } = await import('../CriticalThinkingService')
  return criticalThinkingService
}

/** Calls the service's private synthesis entry point directly and awaits full completion. */
async function runSynthesisDirectly(run: CriticalThinkingRun, signal: AbortSignal): Promise<void> {
  const { criticalThinkingService } = await import('../CriticalThinkingService')
  const service = criticalThinkingService as unknown as {
    runSynthesis: (run: CriticalThinkingRun, signal: AbortSignal) => Promise<void>
  }
  await service.runSynthesis(run, signal)
}

/** Calls the service's private research entry point directly and awaits full completion. */
async function runResearchDirectly(run: CriticalThinkingRun): Promise<void> {
  const { criticalThinkingService } = await import('../CriticalThinkingService')
  const service = criticalThinkingService as unknown as {
    runResearch: (run: CriticalThinkingRun) => Promise<void>
  }
  await service.runResearch(run)
}

/** A combined query+assessment JSON payload: each parser only reads its own fields, so one
 * response can drive either phase. `verdict: 'continue'` keeps every step "hungry" for
 * another round, which is what makes cross-step scheduling fairness observable. */
function neverSufficientResponse(): RunGenerationResult {
  return {
    content: JSON.stringify({
      queries: ['bee sting evidence'],
      finding: 'The investigation is still gathering independent sources.',
      verdict: 'continue',
      evidenceBasis: 'insufficient',
      rationale: 'Not enough independent sources yet.',
      remainingGaps: ['Need more independent sources.'],
      nextQueries: ['bee sting evidence']
    }),
    stats: EMPTY_STATS,
    stopped: false
  }
}

function makeResearchStep(id: string, title: string): CriticalThinkingStepState {
  return {
    id,
    title,
    status: 'pending',
    attempts: 0,
    evidenceIds: [],
    finding: '',
    uncertainties: [],
    rounds: []
  }
}

/** Every fetched URL gets a distinct hostname so domain-diversity selection never dedupes them. */
function seedThreeStepResearchRun(): CriticalThinkingRun {
  const steps = ['step-a', 'step-b', 'step-c'].map((id, index) =>
    makeResearchStep(id, `Step ${String.fromCharCode(65 + index)}`)
  )
  const run = seedRun({
    status: 'researching',
    researchPolicy: {
      maxRoundsPerStep: 2,
      maxQueriesPerRound: 1,
      maxResultsPerQuery: 2,
      maxPagesPerRound: 2,
      searchConcurrency: 1,
      fetchConcurrency: 1,
      maxRoundsPerRun: 20,
      maxSearchesPerRun: 20,
      maxFetchesPerRun: 6,
      maxVerifiedSourcesPerRun: 100,
      maxRunMs: 3_600_000
    },
    plan: {
      title: 'Three-step research plan',
      steps: steps.map((step) => ({ id: step.id, title: step.title, status: 'pending' as const })),
      updatedAt: 1
    },
    steps,
    currentStep: 0
  })

  let urlCounter = 0
  mocks.search.mockImplementation(() =>
    Promise.resolve([
      {
        title: 'Source',
        url: `https://source-${urlCounter++}.example/report`,
        snippet: 'Evidence'
      },
      { title: 'Source', url: `https://source-${urlCounter++}.example/report`, snippet: 'Evidence' }
    ])
  )
  mocks.fetchUrlEvidence.mockImplementation((url: string) =>
    Promise.resolve({
      kind: 'web-fetch',
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      contentType: 'text/html',
      title: 'Fetched source',
      contentHash: `hash-${url}`,
      contentChars: 100,
      truncated: false,
      passages: [{ id: 'P1', text: 'Verified evidence passage.', score: 1 }],
      warnings: []
    })
  )
  mocks.runGeneration.mockImplementation(() => Promise.resolve(neverSufficientResponse()))
  return run
}

const SYNTHESIS_SOURCE: CriticalThinkingSource = {
  id: 'S1',
  title: 'Primary study',
  url: 'https://example.com/study',
  verified: true
}

/** Well-formed enough to satisfy both citation-safety and report-contract validation. */
const VALID_DRAFT = `# Bee and Wasp Sting Comparison

## Executive Summary

Bee venom triggers a sharper, more acute pain response than wasp venom [[S1:P1]].

## Findings

Bee venom triggers a sharper, more acute pain response than wasp venom [[S1:P1]].

## Limits and Open Questions

Additional species remain uncompared.

## Sources

[[S1]]

## Conclusion

The two venoms differ meaningfully in their pain profile [[S1:P1]].`

function synthesisArtifact(): ToolArtifact {
  return {
    id: 'artifact_synthesis',
    conversationId: 'critical_test_synthesis',
    messageId: 'message_synthesis',
    createdAt: 1,
    kind: 'web-fetch',
    requestedUrl: SYNTHESIS_SOURCE.url,
    finalUrl: SYNTHESIS_SOURCE.url,
    status: 200,
    contentType: 'text/html',
    title: SYNTHESIS_SOURCE.title,
    contentHash: 'hash',
    contentChars: 200,
    truncated: false,
    passages: [
      {
        id: 'P1',
        text: 'Bee venom triggers a sharper, more acute pain response than wasp venom.',
        score: 100
      }
    ],
    warnings: [],
    research: { stepId: 'step-1', roundId: 'round_synthesis' }
  }
}

/** Seeds a run ready for synthesis: one completed step, one verified source with a fetched passage. */
function seedSynthesisRun(): CriticalThinkingRun {
  const run = seedRun({
    status: 'researching',
    plan: {
      title: 'Bee and Wasp Sting Pain Research',
      steps: [{ id: 'step-1', title: 'Compare venom composition', status: 'completed' }],
      updatedAt: 1
    },
    steps: [
      {
        id: 'step-1',
        title: 'Compare venom composition',
        status: 'completed',
        attempts: 1,
        evidenceIds: ['artifact_synthesis'],
        finding: 'Bee venom is more acute than wasp venom.',
        uncertainties: [],
        rounds: []
      }
    ],
    sources: [SYNTHESIS_SOURCE]
  })
  mocks.artifacts.set(run.id, [synthesisArtifact()])
  return run
}

beforeEach(() => {
  mocks.runs.clear()
  mocks.artifacts.clear()
  mocks.flushError = null
  mocks.runGeneration.mockReset()
  mocks.search.mockReset()
  mocks.fetchUrlEvidence.mockReset()
})

describe('CriticalThinkingService planning: artifact-first termination semantics', () => {
  it('persists a valid plan on a clean, unstopped completion', async () => {
    const run = seedRun()
    mockPlanResponse({ plan: VALID_PLAN, stopped: false })

    await runPlanningDirectly(run)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('needs-review')
    expect(persisted?.plan?.title).toBe(VALID_PLAN.title)
    expect(persisted?.plan?.steps).toHaveLength(3)
    expect(persisted?.lastError).toBeNull()
  })

  it('persists a valid plan after a recoverable token-limit stop instead of discarding it', async () => {
    const run = seedRun()
    mockPlanResponse({ plan: VALID_PLAN, stopped: true, stopReason: 'token-limit' })

    await runPlanningDirectly(run)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('needs-review')
    expect(persisted?.plan?.title).toBe(VALID_PLAN.title)
    expect(persisted?.lastError).toBeNull()
  })

  it('persists a valid plan after a recoverable context-shift-limit stop instead of discarding it', async () => {
    const run = seedRun()
    mockPlanResponse({ plan: VALID_PLAN, stopped: true, stopReason: 'context-shift-limit' })

    await runPlanningDirectly(run)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('needs-review')
    expect(persisted?.plan?.title).toBe(VALID_PLAN.title)
  })

  it('persists exactly one planning activity for the run', async () => {
    const run = seedRun()
    mockPlanResponse({ plan: VALID_PLAN, stopped: true, stopReason: 'token-limit' })

    await runPlanningDirectly(run)

    const persisted = mocks.runs.get(run.id)
    const planningActivities = (persisted?.activities ?? []).filter((a) => a.kind === 'planning')
    expect(planningActivities).toHaveLength(1)
    expect(planningActivities[0]?.status).toBe('success')
  })

  it('reports Stopped, not a false review-ready plan, when the user stops mid-generation', async () => {
    const run = seedRun()
    mocks.runGeneration.mockImplementation(async (_request: unknown, io: RunGenerationIo) => {
      const service = await getStopHandle()
      service.stop(run.id)
      const usesNativeTool = Boolean(io.enabledTools && io.enabledTools.has('write_plan'))
      if (usesNativeTool) {
        io.onActivity?.({
          id: 'call_user_stop',
          name: 'write_plan',
          kind: 'plan',
          title: `Plan: ${VALID_PLAN.title}`,
          status: 'success',
          plan: VALID_PLAN
        })
      }
      return {
        content: usesNativeTool ? '' : planJson(VALID_PLAN),
        stats: EMPTY_STATS,
        stopped: true
      }
    })

    await runPlanningDirectly(run)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('stopped')
    expect(persisted?.plan).toBeNull()
  })

  it('never enters needs-review when the model never produces valid plan output', async () => {
    const run = seedRun()
    mockPlanResponse({ plan: null, stopped: false, content: 'Sure, let me think about this...' })

    await runPlanningDirectly(run)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('failed')
    expect(persisted?.plan).toBeNull()
    expect(persisted?.lastError).toContain('could not produce a valid research plan')
  })

  it('recovers via one bounded repair attempt when only the first attempt is invalid', async () => {
    const run = seedRun()
    mocks.runGeneration
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: 'not json at all',
          stats: EMPTY_STATS,
          stopped: false
        })
      )
      .mockImplementationOnce((_request: unknown, io: RunGenerationIo) => {
        const usesNativeTool = Boolean(io.enabledTools && io.enabledTools.has('write_plan'))
        if (usesNativeTool) {
          io.onActivity?.({
            id: 'call_repair',
            name: 'write_plan',
            kind: 'plan',
            title: `Plan: ${VALID_PLAN.title}`,
            status: 'success',
            plan: VALID_PLAN
          })
        }
        return Promise.resolve({
          content: usesNativeTool ? '' : planJson(VALID_PLAN),
          stats: EMPTY_STATS,
          stopped: false
        })
      })

    await runPlanningDirectly(run)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('needs-review')
    expect(persisted?.plan?.title).toBe(VALID_PLAN.title)
    expect(mocks.runGeneration).toHaveBeenCalledTimes(2)
  })

  it('remains an explicit failure, never a false review-ready plan, when persistence cannot flush', async () => {
    const run = seedRun()
    mockPlanResponse({ plan: VALID_PLAN, stopped: false })
    mocks.flushError = new Error('disk full')

    await runPlanningDirectly(run)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('failed')
    expect(persisted?.lastError).toContain('could not save')
  })
})

describe('CriticalThinkingService synthesis: artifact-first termination semantics', () => {
  it('completes when the draft validates and generation finished normally', async () => {
    const run = seedSynthesisRun()
    mocks.runGeneration.mockImplementationOnce(() =>
      Promise.resolve({ content: VALID_DRAFT, stats: EMPTY_STATS, stopped: false })
    )

    await runSynthesisDirectly(run, new AbortController().signal)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('completed')
    expect(persisted?.report).toContain('Primary study')
  })

  it('completes a token-limited but valid draft instead of discarding it as partial', async () => {
    const run = seedSynthesisRun()
    mocks.runGeneration.mockImplementationOnce(() =>
      Promise.resolve({
        content: VALID_DRAFT,
        stats: EMPTY_STATS,
        stopped: true,
        stopReason: 'token-limit'
      })
    )

    await runSynthesisDirectly(run, new AbortController().signal)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('completed')
  })

  it('remains partial without attempting validation when an orchestration-level stop cuts synthesis short', async () => {
    const run = seedSynthesisRun()
    mocks.runGeneration.mockImplementationOnce(() =>
      Promise.resolve({
        content: 'Bee venom composition di',
        stats: EMPTY_STATS,
        stopped: true,
        stopReason: 'time-limit'
      })
    )

    await runSynthesisDirectly(run, new AbortController().signal)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('partial')
    expect(persisted?.lastError).toContain('time budget')
  })

  it('reports Stopped when the user stops mid-synthesis, discarding the in-flight draft', async () => {
    const run = seedSynthesisRun()
    const controller = new AbortController()
    mocks.runGeneration.mockImplementationOnce(() => {
      controller.abort('user')
      return Promise.resolve({ content: VALID_DRAFT, stats: EMPTY_STATS, stopped: true })
    })

    await runSynthesisDirectly(run, controller.signal)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('stopped')
  })

  it('keeps a more substantive invalid original over a worse nonempty repair (P0-F)', async () => {
    const run = seedSynthesisRun()
    const substantiveOriginal = `# Bee and Wasp Sting Comparison

## Executive Summary

Bee venom triggers a sharper, more acute pain response than wasp venom [[S1:P1]].

## Findings

Bee venom triggers a sharper, more acute pain response than wasp venom [[S1:P1]].

## Limits and Open Questions

Additional species remain uncompared.

## Sources

[[S1]]`
    // Missing a Conclusion section, so this fails report-contract validation —
    // but it is still far more substantive and better-cited than the repair below.
    mocks.runGeneration
      .mockImplementationOnce(() =>
        Promise.resolve({ content: substantiveOriginal, stats: EMPTY_STATS, stopped: false })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ content: 'Bee stings hurt.', stats: EMPTY_STATS, stopped: false })
      )

    await runSynthesisDirectly(run, new AbortController().signal)

    const persisted = mocks.runs.get(run.id)
    // Neither model draft ever validates on its own (the original is missing
    // a Conclusion section; the repair is far worse) — P0-H's deterministic
    // fallback is what actually completes the run here, citing the same
    // underlying verified passage the original drew from. The point of this
    // test is still P0-F: confirming the worse repair's text never appears.
    expect(persisted?.status).toBe('completed')
    expect(persisted?.report).toContain('sharper, more acute pain response')
    expect(persisted?.report).not.toContain('Bee stings hurt.')
    expect(mocks.runGeneration).toHaveBeenCalledTimes(2)
  })

  it('builds a deterministic report from verified evidence when synthesis and repair both fail validation (P0-H)', async () => {
    const run = seedSynthesisRun()
    // The exact reproduced live failure: a short, uncited fragment that
    // fails both citation-safety and report-contract validation.
    const liveFailureFragment =
      '# Comparative Analysis of Hymenoptera Stings: Honey Bees, Bumblebees,\n\n' +
      '# Yellowjackets, Paper Wasps, and Hornets\n\n' +
      '## Executive Summary\n\n' +
      'This report synthesizes available evidence'
    mocks.runGeneration
      .mockImplementationOnce(() =>
        Promise.resolve({ content: liveFailureFragment, stats: EMPTY_STATS, stopped: false })
      )
      .mockImplementationOnce(() =>
        // The repair attempt also fails to produce anything usable.
        Promise.resolve({ content: 'Still not enough.', stats: EMPTY_STATS, stopped: false })
      )

    await runSynthesisDirectly(run, new AbortController().signal)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.report).toContain('Research result:')
    expect(persisted?.report).toContain('sharper, more acute pain response')
    expect(persisted?.report).not.toContain('This report synthesizes available evidence')
    expect(persisted?.report).not.toContain('Still not enough.')
    expect(mocks.runGeneration).toHaveBeenCalledTimes(2)
  })

  it('completes via repair when the repair recovers a valid draft despite its own recoverable stop', async () => {
    const run = seedSynthesisRun()
    mocks.runGeneration
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: 'An unsupported claim with no citation at all here.',
          stats: EMPTY_STATS,
          stopped: false
        })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: VALID_DRAFT,
          stats: EMPTY_STATS,
          stopped: true,
          stopReason: 'token-limit'
        })
      )

    await runSynthesisDirectly(run, new AbortController().signal)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('completed')
    expect(mocks.runGeneration).toHaveBeenCalledTimes(2)
  })

  it('keeps the original draft and remains partial when repair is cut short by an orchestration-level stop', async () => {
    const run = seedSynthesisRun()
    mocks.runGeneration
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: 'An unsupported claim with no citation at all here.',
          stats: EMPTY_STATS,
          stopped: false
        })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: VALID_DRAFT,
          stats: EMPTY_STATS,
          stopped: true,
          stopReason: 'time-limit'
        })
      )

    await runSynthesisDirectly(run, new AbortController().signal)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('partial')
    expect(persisted?.lastError).toContain('Report repair stopped early')
    // The interrupted repair's own content must never have been promoted —
    // checked via text unique to it (its Limits wording), since the P0-H
    // fallback that fills in for the still-invalid original separately (and
    // legitimately) cites the same underlying passage the repair also drew
    // from, so that phrase alone no longer distinguishes the two.
    expect(persisted?.report).not.toContain('Additional species remain uncompared')
    expect(persisted?.report).toContain('Research result:')
  })

  it('reports Stopped when the user stops mid-repair, discarding the in-flight repair', async () => {
    const run = seedSynthesisRun()
    const controller = new AbortController()
    mocks.runGeneration
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: 'An unsupported claim with no citation at all here.',
          stats: EMPTY_STATS,
          stopped: false
        })
      )
      .mockImplementationOnce(() => {
        controller.abort('user')
        return Promise.resolve({ content: VALID_DRAFT, stats: EMPTY_STATS, stopped: true })
      })

    await runSynthesisDirectly(run, controller.signal)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('stopped')
  })
})

describe('CriticalThinkingService research: breadth-first step scheduling (P0-D)', () => {
  /**
   * Reproduces the shape of the live 8K failure recorded in
   * docs/CONTEXT_ADAPTIVE_RUNTIME_RECOVERY_HANDOFF.md: a sequential
   * depth-first scheduler lets early steps spend their full per-step round
   * budget (and the fetches that come with it) before later approved steps
   * are ever attempted. With `maxRoundsPerStep: 2` and `maxPagesPerRound: 2`,
   * a depth-first scheduler would let step A alone spend both of its rounds
   * (4 fetches) before step B starts, leaving step C's 6-fetch lifetime
   * budget already exhausted by the time step B finishes its own first
   * round — step C would never get a single round. Breadth-first scheduling
   * must instead give every step a first round before any step gets a
   * second, so all three steps show progress even though the run's total
   * fetch budget (6) only covers three single-round attempts.
   */
  it('gives every approved step a first-pass round before any step spends a second', async () => {
    const run = seedThreeStepResearchRun()

    await runResearchDirectly(run)

    const persisted = mocks.runs.get(run.id)
    const roundCounts = persisted?.steps.map((step) => step.rounds.length) ?? []
    expect(roundCounts).toEqual([1, 1, 1])
    expect(persisted?.steps.every((step) => step.rounds.length <= 1)).toBe(true)
  })
})

describe('CriticalThinkingService research: failure salvage', () => {
  it('salvages a report from verified evidence when synthesis throws, instead of failing empty', async () => {
    const run = seedSynthesisRun()
    // The local engine throwing mid-synthesis (e.g. "Object is disposed" when
    // the model reloads) used to end the whole run `failed` with no report,
    // discarding the verified source. It must now assemble the deterministic
    // fallback report from that evidence.
    mocks.runGeneration.mockRejectedValue(new Error('Object is disposed'))

    await runResearchDirectly(run)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('partial')
    // The report is built from the verified passage, not fabricated.
    expect(persisted?.report).toContain('sharper, more acute pain response')
    expect(persisted?.lastError).toContain('Object is disposed')
  })

  it('reports an actionable failure when a research error leaves no verified evidence', async () => {
    const run = seedRun({
      status: 'researching',
      plan: {
        title: 'Venom study',
        steps: [{ id: 'step-1', title: 'Compare venom', status: 'pending' }],
        updatedAt: 1
      },
      steps: [makeResearchStep('step-1', 'Compare venom')],
      sources: []
    })
    // The query-phase model call throws before anything is fetched, so no
    // source is ever verified — an honest, actionable failure, not a
    // fabricated report and not a bare "failed".
    mocks.runGeneration.mockRejectedValue(new Error('model crashed'))

    await runResearchDirectly(run)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('failed')
    expect(persisted?.report ?? '').toBe('')
    expect(persisted?.lastError).toContain('could not gather any usable web sources')
    expect(persisted?.lastError).toContain('model crashed')
  })
})
