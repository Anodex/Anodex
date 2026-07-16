import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type {
  ApproveCriticalThinkingRequest,
  CreateCriticalThinkingRequest,
  CriticalThinkingActivity,
  CriticalThinkingProvider,
  CriticalThinkingRun
} from '@shared/criticalThinking.types'
import type { GenerationStats } from '@shared/chat.types'
import type { Plan } from '@shared/plan.types'
import type { ToolCall } from '@shared/tools.types'
import { runGeneration } from '../chat/runGeneration'
import { llamaService } from '../llama/LlamaService'
import { settingsStore } from '../settings/SettingsStore'
import { showToastWindow } from '../toastWindow'
import { createSearchProvider } from '../tools/search'
import { createLogger } from '../utils/logger'
import { criticalThinkingStore } from './CriticalThinkingStore'
import {
  buildCriticalThinkingPlanPrompt,
  buildCriticalThinkingPlanRetryPrompt,
  buildCriticalThinkingResearchPrompt
} from './criticalThinkingPrompts'
import { mergeSources, sourcesFromReport, sourcesFromSearchResult } from './criticalThinkingSources'

const log = createLogger('critical-thinking-service')
const MAX_QUESTION_CHARS = 8_000
const MAX_PLAN_STEPS = 12
const MAX_PLAN_STEP_CHARS = 240

/**
 * Owns the two-stage Critical Thinking workflow: model-authored plan review,
 * then an evidence-only generation restricted to web search/page-reading tools.
 */
class CriticalThinkingService {
  private activeRunId: string | null = null
  private activeController: AbortController | null = null

  start(request: CreateCriticalThinkingRequest): CriticalThinkingRun {
    if (this.activeRunId) throw new Error('Another Critical Thinking run is already active.')
    const question = request.question.trim()
    if (!question) throw new Error('Enter a question to investigate.')
    if (question.length > MAX_QUESTION_CHARS) {
      throw new Error(`Keep the research question under ${MAX_QUESTION_CHARS} characters.`)
    }

    const settings = settingsStore.get()
    this.assertSearchReady()
    this.assertModelReady(settings.provider.active)
    const provider = settings.provider.active
    const model =
      provider === 'anthropic'
        ? settings.provider.anthropic.model
        : provider === 'openai'
          ? settings.provider.openai.model
          : null
    const run = criticalThinkingStore.create({ question, provider, model })
    this.broadcastRunsChanged()
    void this.runPlanning(run)
    return run
  }

  approve(id: string, request: ApproveCriticalThinkingRequest): CriticalThinkingRun {
    if (this.activeRunId) throw new Error('Another Critical Thinking run is already active.')
    const run = criticalThinkingStore.get(id)
    if (!run) throw new Error('Critical Thinking run not found.')
    if (run.status !== 'needs-review') throw new Error('This research plan is not awaiting review.')
    this.assertSearchReady()
    this.assertModelReady(run.provider)

    const plan = normalizePlan(request.plan)
    const updated = criticalThinkingStore.update(id, {
      status: 'researching',
      plan,
      report: '',
      sources: [],
      activities: [],
      lastError: null
    })
    this.broadcastRunsChanged()
    void this.runResearch(updated)
    return updated
  }

  stop(id: string): void {
    if (this.activeRunId !== id || !this.activeController) {
      throw new Error('That Critical Thinking run is not currently active.')
    }
    this.activeController.abort()
  }

  delete(id: string): void {
    if (this.activeRunId === id) throw new Error('Stop this run before deleting it.')
    criticalThinkingStore.delete(id)
    this.broadcastRunsChanged()
  }

  stopAll(): void {
    this.activeController?.abort()
  }

  private async runPlanning(run: CriticalThinkingRun): Promise<void> {
    this.activeRunId = run.id
    const controller = new AbortController()
    this.activeController = controller
    let combinedStats: GenerationStats | null = null

    try {
      let result = await this.runPlanTurn(
        run,
        buildCriticalThinkingPlanPrompt(run.question),
        controller.signal
      )
      combinedStats = addStats(combinedStats, result.stats)
      let plan = latestPlan(result.calls)

      if (result.stopped) {
        this.finish(run.id, 'stopped', { stats: combinedStats, lastError: 'Research was stopped.' })
        return
      }

      if (!plan) {
        result = await this.runPlanTurn(
          run,
          buildCriticalThinkingPlanRetryPrompt(run.question),
          controller.signal
        )
        combinedStats = addStats(combinedStats, result.stats)
        plan = latestPlan(result.calls)
        if (result.stopped) {
          this.finish(run.id, 'stopped', {
            stats: combinedStats,
            lastError: 'Research was stopped.'
          })
          return
        }
      }

      if (!plan) {
        this.finish(run.id, 'error', {
          stats: combinedStats,
          lastError:
            'The model could not produce a research plan. Try again with a clearer question.'
        })
        return
      }

      criticalThinkingStore.update(run.id, {
        status: 'needs-review',
        plan,
        stats: combinedStats,
        lastError: null
      })
      this.broadcastRunsChanged()
    } catch (error) {
      log.error('Critical Thinking planning failed:', run.id, error)
      this.finish(run.id, controller.signal.aborted ? 'stopped' : 'error', {
        stats: combinedStats,
        lastError: controller.signal.aborted ? 'Research was stopped.' : errorMessage(error)
      })
    } finally {
      this.activeRunId = null
      this.activeController = null
    }
  }

  private async runPlanTurn(
    run: CriticalThinkingRun,
    prompt: string,
    signal: AbortSignal
  ): Promise<{ calls: ToolCall[]; stats: GenerationStats; stopped: boolean }> {
    const calls = new Map<string, ToolCall>()
    const result = await runGeneration(
      {
        conversationId: run.id,
        messageId: generateMessageId(),
        projectId: null,
        history: [],
        prompt,
        options: { temperature: 0.2, maxTokens: 768 }
      },
      {
        signal,
        includeReferenceContext: false,
        enabledTools: new Set(['write_plan']),
        providerOverride: { provider: run.provider, model: run.model ?? undefined },
        permissionModeOverride: 'untethered',
        onActivity: (call) => {
          calls.set(call.id, call)
          this.applyActivity(run.id, call)
        },
        confirm: () => Promise.resolve({ approved: true })
      }
    )
    return { calls: [...calls.values()], stats: result.stats, stopped: result.stopped }
  }

  private async runResearch(run: CriticalThinkingRun): Promise<void> {
    if (!run.plan) throw new Error('A reviewed research plan is required.')
    this.activeRunId = run.id
    const controller = new AbortController()
    this.activeController = controller
    let streamedReport = ''

    try {
      const settings = settingsStore.get()
      const result = await runGeneration(
        {
          conversationId: run.id,
          messageId: generateMessageId(),
          projectId: null,
          history: [],
          prompt: buildCriticalThinkingResearchPrompt(run.question, run.plan),
          plan: run.plan,
          options: settings.generation
        },
        {
          signal: controller.signal,
          includeReferenceContext: false,
          enabledTools: new Set(['web_search', 'fetch_url', 'update_plan_step']),
          providerOverride: { provider: run.provider, model: run.model ?? undefined },
          // Clicking "Start research" is the explicit approval for this
          // bounded web-only run. No write, command, email, MCP, or memory
          // tool is registered into the generation at all.
          permissionModeOverride: 'untethered',
          onToken: (token) => {
            streamedReport += token
            this.broadcastStream(run.id, token)
          },
          onActivity: (call) => this.applyActivity(run.id, call),
          confirm: () => Promise.resolve({ approved: true })
        }
      )

      const report = result.content.trim() || streamedReport.trim()
      const current = criticalThinkingStore.get(run.id) ?? run
      const stats = addStats(current.stats, result.stats)
      const sources = mergeSources(current.sources, sourcesFromReport(report))

      if (result.stopped || controller.signal.aborted) {
        this.finish(run.id, 'stopped', {
          report,
          sources,
          stats,
          lastError: 'Research was stopped.'
        })
        return
      }
      if (!report) {
        this.finish(run.id, 'error', {
          stats,
          sources,
          lastError: 'The investigation finished without producing a report.'
        })
        return
      }

      this.finish(run.id, 'done', {
        report,
        sources,
        stats,
        plan: completePlan(current.plan),
        lastError: null
      })
      showToastWindow({
        title: 'Critical Thinking complete',
        body: truncate(run.question, 140)
      })
    } catch (error) {
      log.error('Critical Thinking research failed:', run.id, error)
      const current = criticalThinkingStore.get(run.id) ?? run
      this.finish(run.id, controller.signal.aborted ? 'stopped' : 'error', {
        report: streamedReport.trim(),
        lastError: controller.signal.aborted ? 'Research was stopped.' : errorMessage(error),
        sources: mergeSources(current.sources, sourcesFromReport(streamedReport))
      })
    } finally {
      this.activeRunId = null
      this.activeController = null
    }
  }

  private applyActivity(runId: string, call: ToolCall): void {
    const run = criticalThinkingStore.get(runId)
    if (!run) return
    const existing = run.activities.find((activity) => activity.id === call.id)
    const activity: CriticalThinkingActivity = {
      id: call.id,
      kind:
        call.name === 'web_search' ? 'search' : call.name === 'fetch_url' ? 'reading' : 'planning',
      label: call.title,
      status: call.status,
      detail: call.detail,
      createdAt: existing?.createdAt ?? Date.now()
    }
    const activities = existing
      ? run.activities.map((item) => (item.id === call.id ? activity : item))
      : [...run.activities, activity]
    const additions =
      call.name === 'web_search' && call.status === 'success'
        ? sourcesFromSearchResult(call.result)
        : []
    criticalThinkingStore.update(runId, {
      activities,
      sources: mergeSources(run.sources, additions),
      plan: call.plan ?? run.plan
    })
    this.broadcastRunsChanged()
  }

  private finish(
    id: string,
    status: Extract<CriticalThinkingRun['status'], 'done' | 'stopped' | 'error'>,
    patch: Partial<CriticalThinkingRun>
  ): void {
    criticalThinkingStore.update(id, { ...patch, status })
    this.broadcastRunsChanged()
  }

  private assertSearchReady(): void {
    const settings = settingsStore.get()
    if (!settings.tools.enabled) {
      throw new Error('Enable AI tools in Settings before starting Critical Thinking.')
    }
    const provider = createSearchProvider(settings.webSearch)
    if (!provider) {
      throw new Error('Choose a web search provider in Settings → Tools before starting.')
    }
  }

  private assertModelReady(provider: CriticalThinkingProvider): void {
    const settings = settingsStore.get()
    if (provider === 'local' && llamaService.getState().status !== 'ready') {
      throw new Error('Load a local model before starting Critical Thinking.')
    }
    if (provider === 'anthropic' && !settings.provider.anthropic.apiKey.trim()) {
      throw new Error('Connect Anthropic in Settings → AI & Models before starting.')
    }
    if (provider === 'openai' && !settings.provider.openai.apiKey.trim()) {
      throw new Error('Connect OpenAI in Settings → AI & Models before starting.')
    }
  }

  private broadcastStream(runId: string, token: string): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.CriticalThinking.stream, { runId, token })
      }
    }
  }

  private broadcastRunsChanged(): void {
    const runs = criticalThinkingStore.list()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.CriticalThinking.runsChanged, runs)
      }
    }
  }
}

function normalizePlan(plan: Plan): Plan {
  const title = plan.title.trim() || 'Research plan'
  const steps = plan.steps
    .map((step) => step.title.trim())
    .filter(Boolean)
    .slice(0, MAX_PLAN_STEPS)
    .map((title) => ({
      id: randomUUID(),
      title: truncate(title, MAX_PLAN_STEP_CHARS),
      status: 'pending' as const
    }))
  if (steps.length === 0) throw new Error('Keep at least one research step in the plan.')
  return { title: truncate(title, MAX_PLAN_STEP_CHARS), steps, updatedAt: Date.now() }
}

function latestPlan(calls: ToolCall[]): Plan | null {
  const planCalls = calls.filter((call) => call.status === 'success' && call.plan)
  return planCalls.at(-1)?.plan ?? null
}

function completePlan(plan: Plan | null): Plan | null {
  if (!plan) return null
  return {
    ...plan,
    steps: plan.steps.map((step) => ({ ...step, status: 'completed' })),
    updatedAt: Date.now()
  }
}

function addStats(current: GenerationStats | null, next: GenerationStats): GenerationStats {
  const tokens = (current?.tokens ?? 0) + next.tokens
  const durationMs = (current?.durationMs ?? 0) + next.durationMs
  return {
    tokens,
    durationMs,
    tokensPerSecond: durationMs > 0 ? tokens / (durationMs / 1000) : 0
  }
}

function generateMessageId(): string {
  return `critical_msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Critical Thinking failed.'
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export const criticalThinkingService = new CriticalThinkingService()
