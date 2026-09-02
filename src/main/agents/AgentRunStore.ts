import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import type { AgentRun, CreateAgentRunRequest } from '@shared/agentRun.types'
import {
  defaultMaxTurnsFor,
  maxTurnsCeilingFor,
  DEFAULT_MAX_TOKENS,
  MAX_MAX_TOKENS,
  DEFAULT_MAX_DURATION_MINUTES,
  MAX_MAX_DURATION_MINUTES
} from '@shared/agentRun.types'
import { agentRunContextSize } from '@shared/agentRunProviders'
import { describeRunProvenance } from './runProvenance'
import { settingsStore } from '../settings/SettingsStore'
import { createLogger } from '../utils/logger'
import { writeJsonFileAtomic } from '../utils/atomicJsonFile'

/**
 * The context window a new run will actually have.
 *
 * Takes the run's own provider: a cloud run's window is its model's, not the
 * local model setting. This used to read `lastModelPath` unconditionally while
 * documenting that it did otherwise, so a cloud run inherited the turn budget
 * of whatever `.gguf` was loaded last.
 */
function runContextSize(request: CreateAgentRunRequest): number | undefined {
  return agentRunContextSize(settingsStore.get(), request.provider, request.model)
}

const log = createLogger('agent-run-store')

const INTERRUPTED_RUN_MESSAGE = 'Interrupted — the app restarted before this run finished.'

/**
 * A run still marked `'running'` at startup was mid-flight when the app last
 * exited (crash, force-quit, restart) — nothing will ever resume it, since
 * `AgentRunService`'s in-memory mutex starts fresh with every process. Left
 * alone it's stuck forever: `stop()` throws ("not currently active", nothing
 * is actually running it) and the UI blocks deleting a `'running'` run. A
 * `'needs-review'` run needs no reconciliation — planning already released
 * the mutex before that status was set, so it's still safely resumable.
 */
export function reconcileInterruptedRuns(runs: AgentRun[]): AgentRun[] {
  return runs.map((run) =>
    run.status === 'running'
      ? { ...run, status: 'stopped', lastError: INTERRUPTED_RUN_MESSAGE }
      : run
  )
}

/**
 * Persists agent runs in their own `userData/agent-runs/runs.json` — same
 * singleton-class + single-JSON-file pattern as `SchedulerStore`.
 */
class AgentRunStore {
  private filePath = ''
  private cache: AgentRun[] | null = null

  /** Must be called after `app.whenReady()`. */
  init(): void {
    const dir = join(app.getPath('userData'), 'agent-runs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, 'runs.json')
    this.cache = this.load()
    log.info('Initialised at', this.filePath)
  }

  list(): AgentRun[] {
    return [...this.ensureCache()]
  }

  get(id: string): AgentRun | undefined {
    return this.ensureCache().find((run) => run.id === id)
  }

  create(request: CreateAgentRunRequest): AgentRun {
    const now = Date.now()
    const run: AgentRun = {
      id: generateId(),
      goal: request.goal.trim(),
      status: 'running',
      projectId: request.projectId,
      enabledTools: request.enabledTools,
      provider: request.provider,
      model: request.provider === 'local' ? null : (request.model?.trim() ?? null),
      // What actually produced this run, so its result can be compared later.
      // `model` above is null for every local run by design - it routes a cloud
      // request rather than describing anything - which left 43 stored runs
      // unattributable and every comparison between them confounded.
      ranWith: describeRunProvenance(request.provider, settingsStore.get()),
      // Both bounds scale with the window a turn actually gets - see
      // `maxTurnsCeilingFor`. At the reference window they are the old
      // constants exactly; on a smaller one they are larger, because a turn
      // there holds a fraction of the work.
      maxTurns: Math.min(
        request.maxTurns ?? defaultMaxTurnsFor(runContextSize(request)),
        maxTurnsCeilingFor(runContextSize(request))
      ),
      turnsUsed: 0,
      flaggedTurns: 0,
      maxTokens: Math.min(request.maxTokens ?? DEFAULT_MAX_TOKENS, MAX_MAX_TOKENS),
      tokensUsed: 0,
      maxDurationMinutes: Math.min(
        request.maxDurationMinutes ?? DEFAULT_MAX_DURATION_MINUTES,
        MAX_MAX_DURATION_MINUTES
      ),
      activeMs: 0,
      activeSinceAt: null,
      limitsEnabled: request.limitsEnabled ?? true,
      conversationId: null,
      summary: null,
      lastError: null,
      requirePlan: request.requirePlan ?? true,
      plan: null,
      createdAt: now,
      updatedAt: now
    }
    const runs = this.ensureCache()
    runs.unshift(run)
    this.persist(runs)
    return run
  }

  update(id: string, patch: Partial<AgentRun>): AgentRun {
    const runs = this.ensureCache()
    const index = runs.findIndex((run) => run.id === id)
    if (index === -1) throw new Error(`Agent run not found: ${id}`)
    const next: AgentRun = { ...runs[index], ...patch, updatedAt: Date.now() }
    runs[index] = next
    this.persist(runs)
    return next
  }

  delete(id: string): void {
    const runs = this.ensureCache().filter((run) => run.id !== id)
    this.persist(runs)
  }

  private ensureCache(): AgentRun[] {
    if (!this.cache) this.cache = this.load()
    return this.cache
  }

  private load(): AgentRun[] {
    if (!existsSync(this.filePath)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<AgentRun>[]
      const normalized = parsed.map(normalizeAgentRun)
      const reconciled = reconcileInterruptedRuns(normalized)
      const needsPersist =
        reconciled.some((run, index) => run !== normalized[index]) ||
        normalized.some(
          (_, index) =>
            parsed[index]?.limitsEnabled === undefined || parsed[index]?.requirePlan === undefined
        )
      if (needsPersist) {
        this.persist(reconciled)
      }
      return reconciled
    } catch (error) {
      log.warn('Failed to parse agent runs, starting fresh:', error)
      return []
    }
  }

  private persist(runs: AgentRun[]): void {
    try {
      // Temp file plus rename, not a write onto the live file. A truncated
      // `runs.json` is not a damaged record but an empty one: `loadRuns` treats
      // a parse failure as "starting fresh" and returns nothing, so a write
      // interrupted by a crash or a full disk would lose every run on record.
      writeJsonFileAtomic(this.filePath, runs)
      this.cache = runs
    } catch (error) {
      log.error('Failed to persist agent runs:', error)
    }
  }
}

function generateId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export function normalizeAgentRun(run: Partial<AgentRun>): AgentRun {
  return {
    ...run,
    limitsEnabled: run.limitsEnabled ?? true,
    requirePlan: run.requirePlan ?? true,
    plan: run.plan ?? null,
    flaggedTurns: run.flaggedTurns ?? 0
  } as AgentRun
}

export const agentRunStore = new AgentRunStore()
