import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CriticalThinkingProvider, CriticalThinkingRun } from '@shared/criticalThinking.types'
import { createLogger } from '../utils/logger'

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

class CriticalThinkingStore {
  private filePath = ''
  private cache: CriticalThinkingRun[] | null = null
  private writeQueue = Promise.resolve()

  /** Must be called after `app.whenReady()`. */
  init(): void {
    const dir = join(app.getPath('userData'), 'critical-thinking')
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
    await this.writeQueue
  }

  private ensureCache(): CriticalThinkingRun[] {
    if (!this.cache) this.cache = this.load()
    return this.cache
  }

  private load(): CriticalThinkingRun[] {
    if (!existsSync(this.filePath)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as CriticalThinkingRun[]
      const reconciled = reconcileInterruptedCriticalThinkingRuns(parsed.map(normalizeRun))
      if (reconciled.some((run, index) => run !== parsed[index])) this.persist(reconciled)
      return reconciled
    } catch (error) {
      log.warn('Failed to parse Critical Thinking runs, starting fresh:', error)
      return []
    }
  }

  private persist(runs: CriticalThinkingRun[]): void {
    this.cache = runs
    const snapshot = JSON.stringify(runs, null, 2)
    this.writeQueue = this.writeQueue
      .then(async () => {
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`
        await writeFile(temporaryPath, snapshot, 'utf8')
        await rename(temporaryPath, this.filePath)
      })
      .catch((error: unknown) => log.error('Failed to persist Critical Thinking runs:', error))
  }
}

function normalizeRun(run: CriticalThinkingRun): CriticalThinkingRun {
  const legacyStatus = run.status as CriticalThinkingRun['status'] | 'done' | 'error'
  const status =
    legacyStatus === 'done' ? 'completed' : legacyStatus === 'error' ? 'failed' : legacyStatus
  const steps =
    run.steps ??
    run.plan?.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status === 'completed' ? ('completed' as const) : ('pending' as const),
      attempts: 0,
      evidenceIds: [],
      finding: '',
      uncertainties: []
    })) ??
    []
  return {
    ...run,
    status,
    report: run.report ?? '',
    sources: (run.sources ?? []).map((source, index) => ({
      ...source,
      id: source.id ?? `S${index + 1}`,
      verified: source.verified ?? false
    })),
    steps,
    currentStep: run.currentStep ?? 0,
    evidenceCount: run.evidenceCount ?? 0,
    activities: run.activities ?? [],
    stats: run.stats ?? null,
    lastError: run.lastError ?? null
  }
}

function generateId(): string {
  return `critical_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export const criticalThinkingStore = new CriticalThinkingStore()
