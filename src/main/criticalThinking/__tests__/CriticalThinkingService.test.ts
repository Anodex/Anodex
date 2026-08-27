import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerationStopReason } from '@shared/chat.types'
import type {
  CriticalThinkingResearchPolicy,
  CriticalThinkingRun,
  CriticalThinkingSource,
  CriticalThinkingStepState
} from '@shared/criticalThinking.types'
import type { Plan } from '@shared/plan.types'
import type {
  ToolArtifact,
  WebFetchArtifact,
  WebFetchArtifactDraft
} from '@shared/toolArtifacts.types'
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

/** The hidden-reasoning sub-budget a phase asked this generation for, if any. */
function thoughtBudgetOf(request: unknown): number | undefined {
  const options = (request as { options?: { thoughtTokens?: unknown } } | null)?.options
  return typeof options?.thoughtTokens === 'number' ? options.thoughtTokens : undefined
}

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
  }
}))

vi.mock('../../tools/search', () => ({
  createSearchProvider: () => ({ search: mocks.search })
}))

vi.mock('../../tools/webTools', () => ({
  fetchUrlEvidence: (...args: [string, string, AbortSignal]) => mocks.fetchUrlEvidence(...args)
}))

// Real generation itself goes through the mocked `runGeneration` above; this
// service only reads `cloudProviderConfigs` for provider ids/display names
// (`assertModelReady`/`resolveCriticalThinkingModel`) — mocked here so
// loading it doesn't pull in the real tool registry's full module graph
// (which `../../tools/webTools`'s mock above only partially covers).
vi.mock('../../llm/cloudProviderConfigs', () => ({
  OPEN_AI_COMPATIBLE_CONFIGS: {
    google: { id: 'google', displayName: 'Google AI' },
    xai: { id: 'xai', displayName: 'xAI' },
    deepseek: { id: 'deepseek', displayName: 'DeepSeek' },
    mistral: { id: 'mistral', displayName: 'Mistral AI' },
    groq: { id: 'groq', displayName: 'Groq' },
    openrouter: { id: 'openrouter', displayName: 'OpenRouter' },
    kimi: { id: 'kimi', displayName: 'Kimi' },
    qwen: { id: 'qwen', displayName: 'Qwen' }
  },
  isOpenAiCompatibleProviderId: (id: string) =>
    ['google', 'xai', 'deepseek', 'mistral', 'groq', 'openrouter', 'kimi', 'qwen'].includes(id)
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

function synthesisArtifact(): WebFetchArtifact {
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

function seedHierarchicalSynthesisRun(): CriticalThinkingRun {
  const run = seedSynthesisRun()
  const secondSource: CriticalThinkingSource = {
    id: 'S2',
    title: 'Independent comparative study',
    url: 'https://example.org/comparison',
    verified: true
  }
  const secondArtifact: ToolArtifact = {
    ...synthesisArtifact(),
    id: 'artifact_synthesis_2',
    requestedUrl: secondSource.url,
    finalUrl: secondSource.url,
    title: secondSource.title,
    contentHash: 'hash-2',
    passages: [
      {
        id: 'P1',
        text: 'Wasp venom produces a longer-lasting inflammatory pain response in the comparison.',
        score: 100
      }
    ],
    research: { stepId: 'step-2', roundId: 'round_synthesis_2' }
  }
  run.plan = {
    ...run.plan!,
    steps: [
      ...run.plan!.steps,
      { id: 'step-2', title: 'Compare inflammatory duration', status: 'completed' }
    ]
  }
  run.steps = [
    ...run.steps,
    {
      id: 'step-2',
      title: 'Compare inflammatory duration',
      status: 'completed',
      attempts: 1,
      evidenceIds: [secondArtifact.id],
      finding: 'Wasp venom can produce a longer inflammatory response.',
      uncertainties: [],
      rounds: []
    }
  ]
  run.sources = [SYNTHESIS_SOURCE, secondSource]
  mocks.runs.set(run.id, run)
  mocks.artifacts.set(run.id, [synthesisArtifact(), secondArtifact])
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
    const request = mocks.runGeneration.mock.calls[0]?.[0] as {
      options?: { jsonSchema?: Record<string, unknown> }
    }
    expect(request.options?.jsonSchema).toMatchObject({
      type: 'object',
      required: ['title', 'steps']
    })
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

  it('never ships a quotation the evidence could not confirm, still wrapped in its marks', async () => {
    // Measured on a live run: the draft was neutralised, a repair then
    // outscored it carrying its own untraceable quotations, and the shipped
    // report still read `A long-tenured reviewer: "Universe Sandbox is truly
    // one of the most mesmerising..."` over text on no page the run read.
    // Neutralising the draft alone was not enough — it has to apply to
    // whichever stage wins.
    const invented = 'the single most mesmerising simulation of recent years'
    const run = seedSynthesisRun()
    mocks.runGeneration.mockImplementationOnce(() =>
      Promise.resolve({
        content: VALID_DRAFT.replace(
          '## Findings',
          `## Findings\n\nA reviewer called it "${invented}" [[S1:P1]].\n`
        ),
        stats: EMPTY_STATS,
        stopped: false
      })
    )

    await runSynthesisDirectly(run, new AbortController().signal)

    const report = mocks.runs.get(run.id)?.report ?? ''
    expect(report).toContain(invented)
    expect(report).not.toContain(`"${invented}"`)
    expect(report).toContain('could not be matched to their cited source')
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

## Sources

[[S1]]`
    // Missing any limits/gaps section, so this fails report-contract validation —
    // but it is safe and far more substantive and better-cited than the repair
    // below, so it is usable and must be kept.
    mocks.runGeneration
      .mockImplementationOnce(() =>
        Promise.resolve({ content: substantiveOriginal, stats: EMPTY_STATS, stopped: false })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ content: 'Bee stings hurt.', stats: EMPTY_STATS, stopped: false })
      )

    await runSynthesisDirectly(run, new AbortController().signal)

    const persisted = mocks.runs.get(run.id)
    // The original is safe (every citation resolves) and substantive, so it is
    // usable and kept directly over the worse repair AND over the blunt
    // deterministic fallback — exactly P0-F's intent. It is reported `partial`
    // (not `completed`) because it acknowledges no limits/gaps, and the worse
    // repair's text must never appear.
    expect(persisted?.status).toBe('partial')
    expect(persisted?.report).toContain('sharper, more acute pain response')
    expect(persisted?.report).not.toContain('Bee stings hurt.')
    expect(mocks.runGeneration).toHaveBeenCalledTimes(2)
  })

  it('keeps a safe, well-cited but unstructured model report instead of the deterministic fallback', async () => {
    // The live case: the model writes a real, safe, well-cited report but
    // organized without the exact section skeleton. It must be shown (partial),
    // not discarded for the blunt deterministic fallback.
    const run = seedSynthesisRun()
    const safeUnstructured = `# Comparative Sting Effects

Bee venom triggers a sharper, more acute pain response than wasp venom [[S1:P1]].

A second substantiated point about the underlying pain mechanism follows [[S1:P1]].`
    mocks.runGeneration.mockImplementation(() =>
      Promise.resolve({ content: safeUnstructured, stats: EMPTY_STATS, stopped: false })
    )

    await runSynthesisDirectly(run, new AbortController().signal)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('partial')
    // The model's own prose is shown …
    expect(persisted?.report).toContain('underlying pain mechanism')
    // … not the deterministic fallback's scaffolding.
    expect(persisted?.report).not.toContain('Findings by Research Step')
    expect(persisted?.report).not.toContain('See findings above.')
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
    expect(persisted?.synthesisDiagnostics?.strategy).toBe('deterministic-fallback')
    expect(persisted?.synthesisDiagnostics?.selectedStage).toBe('deterministic-fallback')
    expect(persisted?.synthesisDiagnostics?.attempts.map((attempt) => attempt.stage)).toEqual([
      'draft',
      'repair',
      'deterministic-fallback'
    ])
  })

  it('recovers a broad local report with independently validated step sections', async () => {
    const run = seedHierarchicalSynthesisRun()
    mocks.runGeneration
      .mockImplementationOnce(() =>
        Promise.resolve({ content: 'A short uncited draft.', stats: EMPTY_STATS, stopped: false })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: 'An equally unusable repair.',
          stats: EMPTY_STATS,
          stopped: false
        })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content:
            'Bee venom produces the sharper acute pain response in the fetched comparison [[S1:P1]].',
          stats: EMPTY_STATS,
          stopped: false
        })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content:
            'Wasp venom produces the longer-lasting inflammatory response in the independent comparison [[S2:P1]].',
          stats: EMPTY_STATS,
          stopped: false
        })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: JSON.stringify({
            executiveSummary:
              'The evidence distinguishes acute intensity from inflammatory duration [[S1:P1]] [[S2:P1]].',
            conclusion:
              'Bee and wasp stings differ along more than one pain dimension [[S1:P1]] [[S2:P1]].'
          }),
          stats: EMPTY_STATS,
          stopped: false
        })
      )

    await runSynthesisDirectly(run, new AbortController().signal)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.report).toContain('sharper acute pain response')
    expect(persisted?.report).toContain('longer-lasting inflammatory response')
    expect(persisted?.report).not.toContain('Research result:')
    expect(persisted?.synthesisDiagnostics?.strategy).toBe('hierarchical-recovery')
    expect(persisted?.synthesisDiagnostics?.selectedStage).toBe('hierarchical-report')
    // A recovered report validates easily -- it is assembled from verified
    // excerpts, so it quotes nothing it cannot prove -- and used to let a run
    // report `completed` while the analysis the question asked for had been
    // discarded. Observed live: a run finished `completed` shipping a log
    // organised by research step with twelve blocks of raw excerpts.
    expect(persisted?.status).toBe('partial')
    expect(persisted?.lastError).toContain('assembled from verified excerpts')
    expect(persisted?.synthesisDiagnostics?.attempts.map((attempt) => attempt.stage)).toEqual([
      'draft',
      'repair',
      'section',
      'section',
      'overview',
      'hierarchical-report'
    ])
    expect(mocks.runGeneration).toHaveBeenCalledTimes(5)
  })

  it('keeps the sections it finished when a later stage is cut short', async () => {
    // Hierarchical recovery only runs after a draft has already failed and
    // eaten part of the budget, so the run's time limit landing part-way
    // through is the ordinary case rather than the exotic one. Every stage
    // used to return `candidate: null` on a non-recoverable stop, discarding
    // sections that were already written and citation-checked — so a run that
    // produced good sections for both steps contributed nothing, and the
    // report fell back to the deterministic bullet-dump.
    const run = seedHierarchicalSynthesisRun()
    mocks.runGeneration
      .mockImplementationOnce(() =>
        Promise.resolve({ content: 'A short uncited draft.', stats: EMPTY_STATS, stopped: false })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: 'An equally unusable repair.',
          stats: EMPTY_STATS,
          stopped: false
        })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content:
            'Bee venom produces the sharper acute pain response in the fetched comparison [[S1:P1]].',
          stats: EMPTY_STATS,
          stopped: false
        })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content:
            'Wasp venom produces the longer-lasting inflammatory response in the independent comparison [[S2:P1]].',
          stats: EMPTY_STATS,
          stopped: false
        })
      )
      // The overview never gets to run to completion.
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: '',
          stats: EMPTY_STATS,
          stopped: true,
          stopReason: 'time-limit'
        })
      )

    await runSynthesisDirectly(run, new AbortController().signal)

    const persisted = mocks.runs.get(run.id)
    // Both finished sections survive, and the assembler supplies its own
    // overview rather than needing the one that was cut off.
    expect(persisted?.report).toContain('sharper acute pain response')
    expect(persisted?.report).toContain('longer-lasting inflammatory response')
    expect(persisted?.report).not.toContain('Research result:')
    // Still partial: the run really was cut short, and the report is missing
    // the cross-section summary it would otherwise have had.
    expect(persisted?.status).toBe('partial')
  })

  it('retains a verified fallback section when both model attempts for one step are unsafe', async () => {
    const run = seedHierarchicalSynthesisRun()
    mocks.runGeneration
      .mockImplementationOnce(() =>
        Promise.resolve({ content: 'A short uncited draft.', stats: EMPTY_STATS, stopped: false })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ content: 'An unusable repair.', stats: EMPTY_STATS, stopped: false })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: 'The acute result was 99 percent [[S1:P1]].',
          stats: EMPTY_STATS,
          stopped: false
        })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: 'The repaired acute result was still 99 percent [[S1:P1]].',
          stats: EMPTY_STATS,
          stopped: false
        })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content:
            'Wasp venom produces the longer-lasting inflammatory response in the independent comparison [[S2:P1]].',
          stats: EMPTY_STATS,
          stopped: false
        })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: JSON.stringify({
            executiveSummary:
              'The retained evidence distinguishes acute pain from inflammatory duration [[S1:P1]] [[S2:P1]].',
            conclusion:
              'Both researched dimensions remain represented in the report [[S1:P1]] [[S2:P1]].'
          }),
          stats: EMPTY_STATS,
          stopped: false
        })
      )

    await runSynthesisDirectly(run, new AbortController().signal)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.report).toContain('sharper, more acute pain response')
    expect(persisted?.report).toContain('longer-lasting inflammatory response')
    expect(persisted?.report).not.toContain('99 percent')
    expect(
      persisted?.synthesisDiagnostics?.attempts.some(
        (attempt) => attempt.stage === 'section-fallback' && attempt.stepId === 'step-1'
      )
    ).toBe(true)
    expect(mocks.runGeneration).toHaveBeenCalledTimes(6)
  })

  it('adds a separately selected chart only when every value validates against one passage', async () => {
    const run = seedSynthesisRun()
    const numericPassage =
      'The measured venom amounts were 59 micrograms for bees and 10 micrograms for wasps.'
    mocks.artifacts.set(run.id, [
      {
        ...synthesisArtifact(),
        passages: [{ id: 'P1', text: numericPassage, score: 100 }]
      }
    ])
    const numericDraft = `# Bee and Wasp Venom Amounts

## Executive Summary

The measured venom amounts were 59 micrograms for bees and 10 micrograms for wasps [[S1:P1]].

## Findings

The comparison retains values of 59 micrograms and 10 micrograms [[S1:P1]].

## Limits and Open Questions

No material gaps recorded.

## Sources

[[S1]]

## Conclusion

The evidence supports the 59 versus 10 microgram comparison [[S1:P1]].`
    mocks.runGeneration
      .mockImplementationOnce(() =>
        Promise.resolve({ content: numericDraft, stats: EMPTY_STATS, stopped: false })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: JSON.stringify({
            charts: [
              {
                type: 'bar',
                title: 'Measured venom amount',
                labels: ['Bee', 'Wasp'],
                datasets: [{ label: 'Amount', values: [59, 10] }],
                unit: 'μg',
                source: '[[S1:P1]]'
              }
            ]
          }),
          stats: EMPTY_STATS,
          stopped: false
        })
      )

    await runSynthesisDirectly(run, new AbortController().signal)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('completed')
    expect(persisted?.report).toContain('## Evidence Charts')
    expect(persisted?.report).toContain('```chart')
    expect(persisted?.synthesisDiagnostics?.selectedStage).toBe('chart')
    expect(persisted?.synthesisDiagnostics?.attempts.at(-1)).toMatchObject({
      stage: 'chart',
      safe: true,
      valid: true
    })
    expect(mocks.runGeneration).toHaveBeenCalledTimes(2)
  })

  it('keeps a valid quantitative report when optional chart selection fails', async () => {
    const run = seedSynthesisRun()
    const numericPassage =
      'The measured venom amounts were 59 micrograms for bees and 10 micrograms for wasps.'
    mocks.artifacts.set(run.id, [
      {
        ...synthesisArtifact(),
        passages: [{ id: 'P1', text: numericPassage, score: 100 }]
      }
    ])
    const numericDraft = `# Bee and Wasp Venom Amounts

## Executive Summary

The measured amounts were 59 micrograms and 10 micrograms [[S1:P1]].

## Findings

The retained values are 59 micrograms and 10 micrograms [[S1:P1]].

## Limits and Open Questions

No material gaps recorded.

## Conclusion

The quantitative comparison remains supported [[S1:P1]].`
    mocks.runGeneration
      .mockImplementationOnce(() =>
        Promise.resolve({ content: numericDraft, stats: EMPTY_STATS, stopped: false })
      )
      .mockRejectedValueOnce(new Error('chart grammar failed'))

    await runSynthesisDirectly(run, new AbortController().signal)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('completed')
    expect(persisted?.report).toContain('59 micrograms')
    expect(persisted?.report).not.toContain('## Evidence Charts')
    expect(persisted?.synthesisDiagnostics?.attempts.at(-1)).toMatchObject({
      stage: 'chart',
      safe: true,
      valid: true
    })
  })

  it('expands a structurally valid but shallow broad local report', async () => {
    const run = seedHierarchicalSynthesisRun()
    const shallowDraft = `# Sting Comparison

## Executive Summary

Bee and wasp stings differ [[S1:P1]] [[S2:P1]].

## Findings

The evidence distinguishes acute pain from inflammatory duration [[S1:P1]] [[S2:P1]].

## Limits and Open Questions

Other species remain unresolved.

## Sources

[[S1]] [[S2]]

## Conclusion

The comparison supports a real difference [[S1:P1]] [[S2:P1]].`
    mocks.runGeneration
      .mockImplementationOnce(() =>
        Promise.resolve({ content: shallowDraft, stats: EMPTY_STATS, stopped: false })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content:
            'The acute-pain evidence attributes the sharper immediate response to bee venom and explains why that dimension matters [[S1:P1]].',
          stats: EMPTY_STATS,
          stopped: false
        })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content:
            'The duration evidence distinguishes the longer inflammatory response associated with wasp venom from immediate intensity [[S2:P1]].',
          stats: EMPTY_STATS,
          stopped: false
        })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: JSON.stringify({
            executiveSummary:
              'Immediate intensity and inflammatory duration are distinct comparative dimensions [[S1:P1]] [[S2:P1]].',
            conclusion:
              'The fuller evidence supports a multidimensional comparison rather than one pain ranking [[S1:P1]] [[S2:P1]].'
          }),
          stats: EMPTY_STATS,
          stopped: false
        })
      )

    await runSynthesisDirectly(run, new AbortController().signal)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.report).toContain('sharper immediate response')
    expect(persisted?.report).toContain('longer inflammatory response')
    expect(persisted?.synthesisDiagnostics?.selectedStage).toBe('hierarchical-report')
    expect(mocks.runGeneration).toHaveBeenCalledTimes(4)
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

describe('CriticalThinkingService: resuming an unfinished run', () => {
  it('reopens steps that were only limited by the run budget', async () => {
    // Every stop reason except a user Stop marks a step `'limited'`, including
    // the run-level budgets that say nothing about that step being exhausted.
    // `runResearchWaves` treats `'limited'` as terminal, so a long run that hit
    // its time budget offered a Resume that did no research at all: every step
    // was skipped and the run went straight back to re-synthesising the
    // evidence it already had. The fresh budget was already there —
    // `runResearch` resets `usage` on every call — only the statuses held it shut.
    const run = seedRun({
      status: 'partial',
      plan: {
        title: 'Bee and Wasp Sting Pain Research',
        steps: [
          { id: 'step-1', title: 'Compare venom composition', status: 'completed' },
          { id: 'step-2', title: 'Compare inflammatory duration', status: 'pending' }
        ],
        updatedAt: 1
      },
      steps: [
        {
          id: 'step-1',
          title: 'Compare venom composition',
          status: 'completed',
          attempts: 1,
          evidenceIds: [],
          finding: 'Bee venom is more acute.',
          uncertainties: [],
          rounds: []
        },
        {
          id: 'step-2',
          title: 'Compare inflammatory duration',
          status: 'limited',
          attempts: 1,
          evidenceIds: [],
          finding: '',
          uncertainties: [],
          rounds: [],
          terminationReason: 'time-limit'
        }
      ]
    })

    const { criticalThinkingService } = await import('../CriticalThinkingService')
    const service = criticalThinkingService as unknown as {
      resume: (id: string) => CriticalThinkingRun
    }
    const resumed = service.resume(run.id)

    // The unfinished step is researchable again...
    expect(resumed.steps[1]).toMatchObject({ status: 'pending', terminationReason: undefined })
    // ...and the finished one keeps its finding and is never revisited.
    expect(resumed.steps[0]).toMatchObject({ status: 'completed' })
    expect(resumed.steps[0].finding).toBe('Bee venom is more acute.')
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

  it('retries a phase without reasoning when it produced no visible output at all', async () => {
    const run = seedSynthesisRun()
    const budgets: (number | undefined)[] = []
    mocks.runGeneration
      .mockImplementationOnce((request: unknown) => {
        budgets.push(thoughtBudgetOf(request))
        // Reasoning consumed the whole call: a token-limit stop with nothing
        // visible to show for it.
        return Promise.resolve({
          content: '',
          thinking: 'Considering the evidence… '.repeat(300),
          stats: EMPTY_STATS,
          stopped: true,
          stopReason: 'token-limit'
        })
      })
      .mockImplementationOnce((request: unknown) => {
        budgets.push(thoughtBudgetOf(request))
        return Promise.resolve({ content: VALID_DRAFT, stats: EMPTY_STATS, stopped: false })
      })

    await runSynthesisDirectly(run, new AbortController().signal)

    // The retry disables reasoning outright rather than asking the engine to
    // close the segment partway, which is the guarantee that actually holds.
    expect(budgets).toHaveLength(2)
    expect(budgets[0]).toBeGreaterThan(0)
    expect(budgets[1]).toBe(0)
    const persisted = mocks.runs.get(run.id)
    expect(persisted?.report).toContain('sharper, more acute pain response')
    expect(persisted?.status).not.toBe('failed')
  })

  it('salvages a report when synthesis spends its whole budget thinking and writes nothing', async () => {
    const run = seedSynthesisRun()
    // The live 32K local failure: the model produced zero visible characters —
    // the entire output budget went to hidden reasoning — and stopped on the
    // token limit. The run used to finish with `report: ''`, throwing away
    // every verified source behind it (53 of them, and 119 evidence artifacts,
    // after 29 minutes of research). An empty draft is a reason to fall back
    // to the evidence, not to discard the investigation.
    mocks.runGeneration.mockResolvedValue({
      content: '',
      thinking: 'Let me consider the evidence… '.repeat(400),
      stats: EMPTY_STATS,
      stopped: true,
      stopReason: 'token-limit'
    })

    await runSynthesisDirectly(run, new AbortController().signal)

    const persisted = mocks.runs.get(run.id)
    expect(persisted?.status).toBe('partial')
    expect(persisted?.report).toContain('sharper, more acute pain response')
    // The stored attempt has to show WHERE the budget went, so a repeat is
    // diagnosable from the run on disk rather than by guesswork.
    const attempt = persisted?.synthesisDiagnostics?.attempts.at(0)
    expect(attempt?.contentChars).toBe(0)
    expect(attempt?.thinkingChars).toBeGreaterThan(0)
    expect(attempt?.stopReason).toBe('token-limit')
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
