import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { AgentRun, CreateAgentRunRequest } from '@shared/agentRun.types'
import {
  DEFAULT_MAX_TURNS,
  MAX_MAX_TURNS,
  DEFAULT_MAX_TOKENS,
  MAX_MAX_TOKENS,
  DEFAULT_MAX_DURATION_MINUTES,
  MAX_MAX_DURATION_MINUTES
} from '@shared/agentRun.types'
import { createLogger } from '../utils/logger'

const log = createLogger('agent-run-store')

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
      maxTurns: Math.min(request.maxTurns ?? DEFAULT_MAX_TURNS, MAX_MAX_TURNS),
      turnsUsed: 0,
      maxTokens: Math.min(request.maxTokens ?? DEFAULT_MAX_TOKENS, MAX_MAX_TOKENS),
      tokensUsed: 0,
      maxDurationMinutes: Math.min(
        request.maxDurationMinutes ?? DEFAULT_MAX_DURATION_MINUTES,
        MAX_MAX_DURATION_MINUTES
      ),
      limitsEnabled: request.limitsEnabled ?? true,
      conversationId: null,
      summary: null,
      lastError: null,
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
      if (normalized.some((_, index) => parsed[index]?.limitsEnabled === undefined)) {
        this.persist(normalized)
      }
      return normalized
    } catch (error) {
      log.warn('Failed to parse agent runs, starting fresh:', error)
      return []
    }
  }

  private persist(runs: AgentRun[]): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(runs, null, 2), 'utf-8')
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
  return { ...run, limitsEnabled: run.limitsEnabled ?? true } as AgentRun
}

export const agentRunStore = new AgentRunStore()
