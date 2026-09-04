import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { writeJsonAtomicAsync } from '../utils/atomicWrite'
import { join } from 'node:path'
import type {
  CriticalThinkingCompletionDiagnostic,
  CriticalThinkingCoverageAssessment,
  CriticalThinkingProvider,
  CriticalThinkingResearchPolicy,
  CriticalThinkingRoundState,
  CriticalThinkingRun,
  CriticalThinkingSource,
  CriticalThinkingStepState
} from '@shared/criticalThinking.types'
import { createLogger } from '../utils/logger'
import {
  DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY,
  researchRunBudgetMs
} from './criticalThinkingResearchPolicy'
import { mergeSources } from './criticalThinkingSources'

const log = createLogger('critical-thinking-store')
const INTERRUPTED_MESSAGE = 'Interrupted — the app restarted before this investigation finished.'

export function reconcileInterruptedCriticalThinkingRuns(
  runs: CriticalThinkingRun[]
): CriticalThinkingRun[] {
  return runs.map((run) =>
    run.status === 'planning' ||
    run.status === 'researching' ||
    run.status === 'synthesizing' ||
    run.status === 'validating'
      ? { ...run, status: 'partial', lastError: INTERRUPTED_MESSAGE }
      : run
  )
}

export class CriticalThinkingStore {
  private filePath = ''
  private cache: CriticalThinkingRun[] | null = null
  private writeQueue = Promise.resolve()
  private pendingRuns: CriticalThinkingRun[] | null = null
  private writerRunning = false
  private lastWriteError: unknown = null

  /** Must be called after `app.whenReady()`. */
  init(directory = join(app.getPath('userData'), 'critical-thinking')): void {
    const dir = directory
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, 'runs.json')
    this.cache = this.load()
    log.info('Initialised at', this.filePath)
  }

  list(): CriticalThinkingRun[] {
    return [...this.ensureCache()]
  }

  get(id: string): CriticalThinkingRun | undefined {
    return this.ensureCache().find((run) => run.id === id)
  }

  create(input: {
    question: string
    provider: CriticalThinkingProvider
    model: string | null
  }): CriticalThinkingRun {
    const now = Date.now()
    const run: CriticalThinkingRun = {
      id: generateId(),
      question: input.question.trim(),
      status: 'planning',
      provider: input.provider,
      model: input.model,
      researchPolicy: {
        ...DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY,
        // A local model spends minutes on a round where a cloud one spends
        // seconds — see `researchRunBudgetMs`.
        maxRunMs: researchRunBudgetMs(input.provider)
      },
      plan: null,
      report: '',
      sources: [],
      steps: [],
      currentStep: 0,
      evidenceCount: 0,
      activities: [],
      stats: null,
      synthesisDiagnostics: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    }
    const runs = this.ensureCache()
    runs.unshift(run)
    this.persist(runs)
    return run
  }

  update(id: string, patch: Partial<CriticalThinkingRun>): CriticalThinkingRun {
    const runs = this.ensureCache()
    const index = runs.findIndex((run) => run.id === id)
    if (index === -1) throw new Error(`Critical Thinking run not found: ${id}`)
    const next = { ...runs[index], ...patch, updatedAt: Date.now() }
    runs[index] = next
    this.persist(runs)
    return next
  }

  delete(id: string): void {
    this.persist(this.ensureCache().filter((run) => run.id !== id))
  }

  async flush(): Promise<void> {
    while (this.pendingRuns !== null || this.writerRunning) {
      if (this.pendingRuns !== null && !this.writerRunning) this.startWriter()
      const activeWriter = this.writeQueue
      await activeWriter
      if (this.lastWriteError) throw persistenceError(this.lastWriteError)
    }

    if (this.lastWriteError) throw persistenceError(this.lastWriteError)
  }

  private ensureCache(): CriticalThinkingRun[] {
    if (!this.cache) this.cache = this.load()
    return this.cache
  }

  private load(): CriticalThinkingRun[] {
    if (!existsSync(this.filePath)) return []
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf-8')
      const parsedValue: unknown = JSON.parse(raw)
      if (!Array.isArray(parsedValue)) throw new Error('Critical Thinking store must be an array.')
      // Normalized one run at a time. A single malformed entry — a `plan.steps`
      // that is not an array, say — used to throw out of the whole `map` and
      // land in the catch below, which starts empty: one bad run cost every
      // other investigation in the file. Now it costs itself.
      const parsed = parsedValue.filter(isRecord)
      const normalized = parsed.flatMap((run) => {
        try {
          return [normalizeCriticalThinkingRun(run as unknown as CriticalThinkingRun)]
        } catch (error) {
          log.warn('Dropping an unreadable Critical Thinking run:', error)
          return []
        }
      })
      const reconciled = reconcileInterruptedCriticalThinkingRuns(normalized)
      // Compared against the bytes on disk rather than by object identity.
      // `normalizeCriticalThinkingRun` always returns a fresh object, so the
      // previous `run !== parsed[index]` was true for every run on every
      // launch — a guard that read as "only write when something changed" and
      // in fact rewrote the whole file each time the app started.
      if (JSON.stringify(reconciled, null, 2) !== raw) this.persist(reconciled)
      return reconciled
    } catch (error) {
      // Falling back to empty is right — the feature has to open. Doing it
      // without moving the file aside was destructive: `ensureCache` caches the
      // empty list and the next `create`/`update`/`delete` persists it straight
      // over the original, taking every past investigation with it. Same
      // quarantine the settings, conversation, checkpoint and email-credential
      // stores already do.
      this.quarantine(error)
      return []
    }
  }

  /** Move an unreadable run file aside, best effort. */
  private quarantine(error: unknown): void {
    const aside = `${this.filePath}.corrupt`
    try {
      renameSync(this.filePath, aside)
      log.warn(`Could not parse Critical Thinking runs; moved to ${aside}.`, error)
    } catch (renameError) {
      log.error(
        'Could not parse Critical Thinking runs and could not move the file aside — the next ' +
          'save will overwrite it:',
        renameError
      )
    }
  }

  private persist(runs: CriticalThinkingRun[]): void {
    this.cache = runs
    this.pendingRuns = runs
    if (!this.writerRunning) this.startWriter()
  }

  private startWriter(): void {
    this.writerRunning = true
    // Defer one microtask so synchronous progress updates collapse into one
    // latest-state write instead of serializing and writing runs.json each time.
    this.writeQueue = Promise.resolve().then(() => this.drainWrites())
  }

  private async drainWrites(): Promise<void> {
    try {
      while (this.pendingRuns) {
        const runs = this.pendingRuns
        this.pendingRuns = null
        try {
          await writeJsonAtomicAsync(this.filePath, runs)
          this.lastWriteError = null
        } catch (error) {
          this.lastWriteError = error
          this.pendingRuns ??= this.cache
          log.error('Failed to persist Critical Thinking runs:', error)
          return
        }
      }
    } finally {
      this.writerRunning = false
    }
  }
}

function persistenceError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('Failed to persist Critical Thinking state.', { cause: error })
}

/** Upgrade persisted runs without discarding resumable research state. */
export function normalizeCriticalThinkingRun(run: CriticalThinkingRun): CriticalThinkingRun {
  const legacyStatus = run.status as CriticalThinkingRun['status'] | 'done' | 'error'
  const status =
    legacyStatus === 'done' ? 'completed' : legacyStatus === 'error' ? 'failed' : legacyStatus
  const legacySteps: unknown[] = Array.isArray(run.steps)
    ? run.steps
    : (run.plan?.steps.map((step) => ({
        id: step.id,
        title: step.title,
        status: step.status === 'completed' ? ('completed' as const) : ('pending' as const)
      })) ?? [])
  const sources = Array.isArray(run.sources)
    ? (run.sources as unknown[]).flatMap((source) => {
        const normalized = normalizeSource(source)
        return normalized ? [normalized] : []
      })
    : []
  return {
    ...run,
    status,
    researchPolicy: normalizeResearchPolicy(run.researchPolicy),
    ...(typeof run.evidenceBudgetBase === 'number' && Number.isFinite(run.evidenceBudgetBase)
      ? { evidenceBudgetBase: nonNegativeInteger(run.evidenceBudgetBase) }
      : {}),
    report: run.report ?? '',
    sources: mergeSources(sources, []),
    steps: legacySteps.map(normalizeStep),
    currentStep: run.currentStep ?? 0,
    evidenceCount: run.evidenceCount ?? 0,
    activities: run.activities ?? [],
    stats: run.stats ?? null,
    synthesisDiagnostics: normalizeSynthesisDiagnostics(run.synthesisDiagnostics),
    lastError: run.lastError ?? null
  }
}

function normalizeSynthesisDiagnostics(
  value: CriticalThinkingRun['synthesisDiagnostics']
): CriticalThinkingRun['synthesisDiagnostics'] {
  if (!isRecord(value)) return null
  const strategies = ['single-pass', 'hierarchical-recovery', 'deterministic-fallback'] as const
  const stages = [
    'draft',
    'repair',
    'section',
    'section-repair',
    'section-fallback',
    'consistency',
    'overview',
    'chart',
    'hierarchical-report',
    'deterministic-fallback'
  ] as const
  const strategy = strategies.find((item) => item === value.strategy) ?? 'single-pass'
  const selectedStage = stages.find((item) => item === value.selectedStage) ?? null
  const attempts = Array.isArray(value.attempts)
    ? value.attempts
        .filter(isRecord)
        .slice(-32)
        .flatMap((attempt) => {
          const stage = stages.find((item) => item === attempt.stage)
          if (!stage) return []
          return [
            {
              stage,
              ...(typeof attempt.stepId === 'string'
                ? { stepId: boundedStoreText(attempt.stepId, 200) }
                : {}),
              contentChars: nonNegativeInteger(attempt.contentChars),
              // Mirrors `MAX_SYNTHESIS_DIAGNOSTIC_CONTENT_CHARS` in the
              // service, and re-bounds drafts persisted by an older build.
              content: typeof attempt.content === 'string' ? attempt.content.slice(0, 12_000) : '',
              ...(typeof attempt.thinkingChars === 'number'
                ? { thinkingChars: nonNegativeInteger(attempt.thinkingChars) }
                : {}),
              ...(isTerminationReason(attempt.stopReason)
                ? { stopReason: attempt.stopReason }
                : {}),
              safe: attempt.safe === true,
              usable: attempt.usable === true,
              valid: attempt.valid === true,
              citedBlockCount: nonNegativeInteger(attempt.citedBlockCount),
              ...(Array.isArray(attempt.contractIssues) && attempt.contractIssues.length > 0
                ? {
                    contractIssues: stringArray(attempt.contractIssues)
                      .map((issue) => boundedStoreText(issue, 500))
                      .filter(Boolean)
                      .slice(0, 12)
                  }
                : {}),
              issues: stringArray(attempt.issues)
                .map((issue) => boundedStoreText(issue, 500))
                .filter(Boolean)
                .slice(0, 24)
            }
          ]
        })
    : []
  const completion = normalizeCompletion(value.completion)
  return {
    startedAt: nonNegativeInteger(value.startedAt),
    completedAt: typeof value.completedAt === 'number' ? value.completedAt : null,
    verifiedSourceCount: nonNegativeInteger(value.verifiedSourceCount),
    evidencePacketChars: nonNegativeInteger(value.evidencePacketChars),
    evidenceCorpusChars: nonNegativeInteger(value.evidenceCorpusChars),
    strategy,
    selectedStage,
    chartAdded: value.chartAdded === true,
    ...(completion ? { completion } : {}),
    attempts
  }
}

/**
 * Keep the completion verdict across a restart.
 *
 * It was recorded on the run but not listed here, and this normaliser rebuilds
 * every diagnostic field by name on load -- so the field survived until the app
 * next started and then silently vanished. Measured: a run's `blockers` were
 * read once from the live file and were gone from the same run an hour later,
 * which is precisely when a stored diagnostic is most needed.
 */
function normalizeCompletion(value: unknown): CriticalThinkingCompletionDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  return {
    usable: raw.usable === true,
    structurallyValid: raw.structurallyValid === true,
    limitedSteps: raw.limitedSteps === true,
    recoveredStage: raw.recoveredStage === true,
    repairStopped: raw.repairStopped === true,
    otherSafetyIssueCount: nonNegativeInteger(raw.otherSafetyIssueCount),
    unverifiedQuotationCount: nonNegativeInteger(raw.unverifiedQuotationCount),
    unverifiedFigureCount: nonNegativeInteger(raw.unverifiedFigureCount),
    citedSubstantiveBlockCount: nonNegativeInteger(raw.citedSubstantiveBlockCount),
    blockers: stringArray(raw.blockers).slice(0, 12)
  }
}

function normalizeSource(value: unknown): CriticalThinkingSource | null {
  if (!isRecord(value) || typeof value.url !== 'string' || value.url.length > 4_096) return null
  let url: URL
  try {
    url = new URL(value.url)
  } catch {
    return null
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    return null
  }
  const title = boundedStoreText(value.title, 300) || url.hostname
  const snippet = boundedStoreText(value.snippet, 500)
  return {
    id: typeof value.id === 'string' ? value.id : '',
    title,
    url: url.toString(),
    ...(snippet ? { snippet } : {}),
    verified: value.verified === true
  }
}

function boundedStoreText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  const normalized = value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized
}

function normalizeResearchPolicy(
  policy: CriticalThinkingResearchPolicy | undefined
): CriticalThinkingResearchPolicy {
  const persisted: Record<string, unknown> = isRecord(policy) ? policy : {}
  return {
    maxRoundsPerStep: positiveInteger(
      persisted.maxRoundsPerStep,
      DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY.maxRoundsPerStep
    ),
    maxQueriesPerRound: positiveInteger(
      persisted.maxQueriesPerRound,
      DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY.maxQueriesPerRound
    ),
    maxResultsPerQuery: positiveInteger(
      persisted.maxResultsPerQuery,
      DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY.maxResultsPerQuery
    ),
    maxPagesPerRound: positiveInteger(
      persisted.maxPagesPerRound,
      DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY.maxPagesPerRound
    ),
    searchConcurrency: positiveInteger(
      persisted.searchConcurrency,
      DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY.searchConcurrency
    ),
    fetchConcurrency: positiveInteger(
      persisted.fetchConcurrency,
      DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY.fetchConcurrency
    ),
    maxRoundsPerRun: positiveInteger(
      persisted.maxRoundsPerRun,
      DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY.maxRoundsPerRun
    ),
    maxSearchesPerRun: positiveInteger(
      persisted.maxSearchesPerRun,
      DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY.maxSearchesPerRun
    ),
    maxFetchesPerRun: positiveInteger(
      persisted.maxFetchesPerRun,
      DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY.maxFetchesPerRun
    ),
    maxVerifiedSourcesPerRun: positiveInteger(
      persisted.maxVerifiedSourcesPerRun,
      DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY.maxVerifiedSourcesPerRun
    ),
    maxRunMs: positiveInteger(
      persisted.maxRunMs,
      DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY.maxRunMs
    )
  }
}

function normalizeStep(step: unknown): CriticalThinkingStepState {
  const value: Record<string, unknown> = isRecord(step) ? step : {}
  const status = isStepStatus(value.status) ? value.status : 'pending'
  return {
    id: typeof value.id === 'string' ? value.id : generateId(),
    title: typeof value.title === 'string' ? value.title : 'Research step',
    status,
    attempts: nonNegativeInteger(value.attempts),
    evidenceIds: stringArray(value.evidenceIds),
    finding: typeof value.finding === 'string' ? value.finding : '',
    uncertainties: stringArray(value.uncertainties),
    rounds: Array.isArray(value.rounds)
      ? value.rounds.filter(isRecord).map((round, index) => normalizeRound(round, index))
      : [],
    ...(typeof value.roundBudgetBase === 'number' && Number.isFinite(value.roundBudgetBase)
      ? { roundBudgetBase: nonNegativeInteger(value.roundBudgetBase) }
      : {}),
    ...(isTerminationReason(value.terminationReason)
      ? { terminationReason: value.terminationReason }
      : {})
  }
}

function normalizeRound(
  round: Record<string, unknown>,
  fallbackIndex: number
): CriticalThinkingRoundState {
  return {
    id: typeof round.id === 'string' ? round.id : `round_${fallbackIndex + 1}`,
    index: nonNegativeInteger(round.index, fallbackIndex),
    status: isRoundStatus(round.status) ? round.status : 'failed',
    queries: stringArray(round.queries),
    selectedUrls: stringArray(round.selectedUrls),
    evidenceIds: stringArray(round.evidenceIds),
    finding: typeof round.finding === 'string' ? round.finding : '',
    assessment: normalizeAssessment(round.assessment),
    ...(isTerminationReason(round.terminationReason)
      ? { terminationReason: round.terminationReason }
      : {}),
    startedAt: nonNegativeInteger(round.startedAt),
    completedAt: typeof round.completedAt === 'number' ? round.completedAt : null
  }
}

function normalizeAssessment(value: unknown): CriticalThinkingCoverageAssessment | null {
  if (!isRecord(value)) return null
  if (value.verdict !== 'continue' && value.verdict !== 'sufficient') return null
  if (
    value.evidenceBasis !== 'multiple-sources' &&
    value.evidenceBasis !== 'authoritative-primary' &&
    value.evidenceBasis !== 'insufficient'
  ) {
    return null
  }
  return {
    verdict: value.verdict,
    evidenceBasis: value.evidenceBasis,
    rationale: typeof value.rationale === 'string' ? value.rationale : '',
    remainingGaps: stringArray(value.remainingGaps),
    nextQueries: stringArray(value.nextQueries)
  }
}

function isStepStatus(value: unknown): value is CriticalThinkingStepState['status'] {
  return (
    value === 'pending' ||
    value === 'researching' ||
    value === 'completed' ||
    value === 'limited' ||
    value === 'failed'
  )
}

function isRoundStatus(value: unknown): value is CriticalThinkingRoundState['status'] {
  return (
    value === 'querying' ||
    value === 'searching' ||
    value === 'reading' ||
    value === 'assessing' ||
    value === 'completed' ||
    value === 'limited' ||
    value === 'stopped' ||
    value === 'failed'
  )
}

function isTerminationReason(
  value: unknown
): value is NonNullable<CriticalThinkingStepState['terminationReason']> {
  return (
    value === 'user' ||
    value === 'loop-guard' ||
    value === 'context-limit' ||
    value === 'context-shift-limit' ||
    value === 'fixed-context-limit' ||
    value === 'rounds-exhausted' ||
    value === 'time-limit' ||
    value === 'tool-limit' ||
    value === 'token-limit' ||
    value === 'no-progress' ||
    value === 'yielded' ||
    value === 'evidence-limit'
  )
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function generateId(): string {
  return `critical_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export const criticalThinkingStore = new CriticalThinkingStore()
