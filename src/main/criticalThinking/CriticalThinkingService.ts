import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type {
  ApproveCriticalThinkingRequest,
  CreateCriticalThinkingRequest,
  CriticalThinkingActivity,
  CriticalThinkingProvider,
  CriticalThinkingRun,
  CriticalThinkingStepState
} from '@shared/criticalThinking.types'
import type { GenerationStats, GenerationStopReason } from '@shared/chat.types'
import type { Plan } from '@shared/plan.types'
import type { ToolCall } from '@shared/tools.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import { runGeneration, type RunGenerationResult } from '../chat/runGeneration'
import { CRITICAL_THINKING_STEP_BUDGET } from '../chat/GenerationBudget'
import { llamaService } from '../llama/LlamaService'
import { settingsStore } from '../settings/SettingsStore'
import { showToastWindow } from '../toastWindow'
import { createSearchProvider } from '../tools/search'
import { createLogger } from '../utils/logger'
import { criticalThinkingEvidenceStore } from './CriticalThinkingEvidenceStore'
import { criticalThinkingStore } from './CriticalThinkingStore'
import {
  buildCriticalThinkingPlanPrompt,
  buildCriticalThinkingPlanRetryPrompt,
  buildCriticalThinkingRepairPrompt,
  buildCriticalThinkingStepPrompt,
  buildCriticalThinkingSynthesisPrompt
} from './criticalThinkingPrompts'
import {
  buildEvidencePacket,
  renderResearchCitations,
  validateResearchReport
} from './criticalThinkingEvidence'
import { mergeSources, sourcesFromArtifact } from './criticalThinkingSources'

const log = createLogger('critical-thinking-service')
const MAX_QUESTION_CHARS = 8_000
const MAX_PLAN_STEPS = 12
const MAX_PLAN_STEP_CHARS = 240
const MAX_STEP_FINDING_CHARS = 4_000
const MAX_TOTAL_RUN_MS = 60 * 60_000
const SYNTHESIS_BUDGET = { ...CRITICAL_THINKING_STEP_BUDGET, maxTools: 0 }

/** Persisted, bounded research workflow with evidence outside the model transcript. */
class CriticalThinkingService {
  private activeRunId: string | null = null
  private activeController: AbortController | null = null
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null

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
    const run = this.requireRun(id)
    if (run.status !== 'needs-review') throw new Error('This research plan is not awaiting review.')
    this.assertSearchReady()
    this.assertModelReady(run.provider)

    const plan = normalizePlan(request.plan)
    criticalThinkingEvidenceStore.delete(id)
    const updated = criticalThinkingStore.update(id, {
      status: 'researching',
      plan,
      steps: createStepStates(plan),
      currentStep: 0,
      evidenceCount: 0,
      report: '',
      sources: [],
      activities: [],
      lastError: null
    })
    this.broadcastRunsChanged()
    void this.runResearch(updated)
    return updated
  }

  resume(id: string): CriticalThinkingRun {
    if (this.activeRunId) throw new Error('Another Critical Thinking run is already active.')
    const run = this.requireRun(id)
    if (!run.plan || !['partial', 'stopped', 'failed'].includes(run.status)) {
      throw new Error('This investigation is not resumable.')
    }
    this.assertSearchReady()
    this.assertModelReady(run.provider)
    const updated = criticalThinkingStore.update(id, {
      status: 'researching',
      report: '',
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
    criticalThinkingEvidenceStore.delete(id)
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
      if (result.stopped) return this.finishPlanningStop(run.id, combinedStats, result.stopReason)

      if (!plan) {
        result = await this.runPlanTurn(
          run,
          buildCriticalThinkingPlanRetryPrompt(run.question),
          controller.signal
        )
        combinedStats = addStats(combinedStats, result.stats)
        plan = latestPlan(result.calls)
        if (result.stopped) return this.finishPlanningStop(run.id, combinedStats, result.stopReason)
      }

      if (!plan) {
        this.finish(run.id, 'failed', {
          stats: combinedStats,
          lastError: 'The model could not produce a research plan. Try a clearer question.'
        })
        return
      }
      criticalThinkingStore.update(run.id, {
        status: 'needs-review',
        plan,
        steps: createStepStates(plan),
        stats: combinedStats,
        lastError: null
      })
      this.broadcastRunsChanged()
    } catch (error) {
      log.error('Critical Thinking planning failed:', run.id, error)
      this.finish(run.id, controller.signal.aborted ? 'stopped' : 'failed', {
        stats: combinedStats,
        lastError: controller.signal.aborted ? 'Research was stopped.' : errorMessage(error)
      })
    } finally {
      await criticalThinkingStore.flush()
      this.clearActiveRun()
    }
  }

  private async runPlanTurn(
    run: CriticalThinkingRun,
    prompt: string,
    signal: AbortSignal
  ): Promise<{
    calls: ToolCall[]
    stats: GenerationStats
    stopped: boolean
    stopReason?: GenerationStopReason
  }> {
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
        executionBudget: CRITICAL_THINKING_STEP_BUDGET,
        onActivity: (call) => {
          calls.set(call.id, call)
          this.applyActivity(run.id, call)
        },
        confirm: () => Promise.resolve({ approved: true })
      }
    )
    return { calls: [...calls.values()], ...pickGenerationResult(result) }
  }

  private async runResearch(initialRun: CriticalThinkingRun): Promise<void> {
    if (!initialRun.plan) throw new Error('A reviewed research plan is required.')
    this.activeRunId = initialRun.id
    const controller = new AbortController()
    this.activeController = controller
    let totalTimedOut = false
    const totalTimer = setTimeout(() => {
      totalTimedOut = true
      controller.abort()
    }, MAX_TOTAL_RUN_MS)

    try {
      for (let index = 0; index < initialRun.steps.length; index++) {
        const current = this.requireRun(initialRun.id)
        const step = current.steps[index]
        if (step.status === 'completed') continue
        if (controller.signal.aborted) break
        await this.runResearchStep(current, index, controller.signal)
      }

      const current = this.requireRun(initialRun.id)
      if (controller.signal.aborted) {
        this.finish(initialRun.id, totalTimedOut ? 'partial' : 'stopped', {
          lastError: totalTimedOut
            ? 'The investigation reached its one-hour run budget and can be resumed.'
            : 'Research was stopped. You can resume from the saved evidence.'
        })
        return
      }
      await this.runSynthesis(current, controller.signal)
    } catch (error) {
      log.error('Critical Thinking research failed:', initialRun.id, error)
      this.finish(initialRun.id, controller.signal.aborted ? 'stopped' : 'failed', {
        lastError: controller.signal.aborted ? 'Research was stopped.' : errorMessage(error)
      })
    } finally {
      clearTimeout(totalTimer)
      await criticalThinkingEvidenceStore.flush()
      await criticalThinkingStore.flush()
      this.clearActiveRun()
    }
  }

  private async runResearchStep(
    run: CriticalThinkingRun,
    index: number,
    signal: AbortSignal
  ): Promise<void> {
    const step = run.steps[index]
    const startedArtifacts = criticalThinkingEvidenceStore.list(run.id)
    this.updateStep(run.id, index, {
      status: 'researching',
      attempts: step.attempts + 1,
      terminationReason: undefined
    })
    this.updatePlanProgress(run.id, index, 'in_progress')
    criticalThinkingStore.update(run.id, { status: 'researching', currentStep: index })
    this.broadcastRunsChanged()

    const priorFindings = run.steps
      .slice(0, index)
      .map((item) => item.finding)
      .filter(Boolean)
    const result = await runGeneration(
      {
        conversationId: run.id,
        messageId: generateMessageId(),
        projectId: null,
        history: [],
        prompt: buildCriticalThinkingStepPrompt(run.question, step.title, priorFindings),
        options: { temperature: 0.2, maxTokens: 1_200 }
      },
      {
        signal,
        includeReferenceContext: false,
        enabledTools: new Set(['web_search', 'fetch_url']),
        providerOverride: { provider: run.provider, model: run.model ?? undefined },
        permissionModeOverride: 'untethered',
        executionBudget: CRITICAL_THINKING_STEP_BUDGET,
        evidenceFocus: `${run.question}\n${step.title}`,
        onArtifact: (artifact) => this.recordArtifact(run.id, artifact),
        onActivity: (call) => this.applyActivity(run.id, call),
        confirm: () => Promise.resolve({ approved: true })
      }
    )

    const latest = this.requireRun(run.id)
    const newArtifactIds = criticalThinkingEvidenceStore
      .list(run.id)
      .slice(startedArtifacts.length)
      .map((artifact) => artifact.id)
    const finding = truncate(result.content.trim(), MAX_STEP_FINDING_CHARS)
    const status = result.stopped
      ? result.stopReason === 'user'
        ? 'pending'
        : 'limited'
      : 'completed'
    this.updateStep(run.id, index, {
      status,
      evidenceIds: [...new Set([...latest.steps[index].evidenceIds, ...newArtifactIds])],
      finding,
      uncertainties: result.stopped ? [stoppedReasonMessage(result.stopReason)] : [],
      terminationReason: result.stopReason
    })
    this.updatePlanProgress(run.id, index, status === 'completed' ? 'completed' : 'pending')
    criticalThinkingStore.update(run.id, { stats: addStats(latest.stats, result.stats) })
    this.broadcastRunsChanged()
  }

  private async runSynthesis(run: CriticalThinkingRun, signal: AbortSignal): Promise<void> {
    const artifacts = criticalThinkingEvidenceStore.list(run.id)
    const verifiedSources = run.sources.filter((source) => source.verified)
    const evidencePacket = buildEvidencePacket(artifacts, run.sources)
    if (!evidencePacket || verifiedSources.length === 0) {
      this.finish(run.id, 'partial', {
        lastError:
          'Research finished without a fetched source that could support a validated report.'
      })
      return
    }

    criticalThinkingStore.update(run.id, { status: 'synthesizing', report: '' })
    this.broadcastRunsChanged()
    const synthesis = await this.runToolFreeTurn(
      run,
      buildCriticalThinkingSynthesisPrompt(
        run.question,
        run.plan!,
        run.steps.map((step) => step.finding).filter(Boolean),
        evidencePacket
      ),
      signal,
      true
    )
    let draft = synthesis.content.trim()
    let stats = addStats(run.stats, synthesis.stats)
    if (synthesis.stopped || !draft) {
      this.finish(run.id, 'partial', {
        report: draft,
        stats,
        lastError: stoppedReasonMessage(synthesis.stopReason)
      })
      return
    }

    criticalThinkingStore.update(run.id, { status: 'validating', report: draft, stats })
    this.broadcastRunsChanged()
    let validation = validateResearchReport(draft, artifacts, run.sources)
    if (!validation.valid) {
      const repair = await this.runToolFreeTurn(
        run,
        buildCriticalThinkingRepairPrompt(draft, validation.issues, evidencePacket),
        signal,
        false
      )
      stats = addStats(stats, repair.stats)
      if (repair.content.trim()) draft = repair.content.trim()
      validation = validateResearchReport(draft, artifacts, run.sources)
    }

    const report = renderResearchCitations(draft, run.sources)
    const limitedSteps = run.steps.some((step) => step.status !== 'completed')
    const status = validation.valid && !limitedSteps ? 'completed' : 'partial'
    this.finish(run.id, status, {
      report,
      stats,
      plan: status === 'completed' ? completePlan(run.plan) : run.plan,
      lastError: validation.valid
        ? limitedSteps
          ? 'Some research steps reached their execution budget; this report uses the evidence collected.'
          : null
        : `Citation validation remained incomplete: ${validation.issues.join(' ')}`
    })
    showToastWindow({
      title: status === 'completed' ? 'Critical Thinking complete' : 'Partial research ready',
      body: truncate(run.question, 140)
    })
  }

  private async runToolFreeTurn(
    run: CriticalThinkingRun,
    prompt: string,
    signal: AbortSignal,
    stream: boolean
  ): Promise<RunGenerationResult> {
    return runGeneration(
      {
        conversationId: run.id,
        messageId: generateMessageId(),
        projectId: null,
        history: [],
        prompt,
        options: { temperature: 0.2, maxTokens: 4_096 }
      },
      {
        signal,
        includeReferenceContext: false,
        enabledTools: new Set(),
        providerOverride: { provider: run.provider, model: run.model ?? undefined },
        permissionModeOverride: 'untethered',
        executionBudget: SYNTHESIS_BUDGET,
        onToken: stream ? (token) => this.broadcastStream(run.id, token) : undefined,
        confirm: () => Promise.resolve({ approved: true })
      }
    )
  }

  private recordArtifact(runId: string, artifact: ToolArtifact): void {
    criticalThinkingEvidenceStore.record(runId, artifact)
    const run = this.requireRun(runId)
    criticalThinkingStore.update(runId, {
      sources: mergeSources(run.sources, sourcesFromArtifact(artifact)),
      evidenceCount: run.evidenceCount + 1
    })
    this.broadcastRunsChanged(true)
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
    criticalThinkingStore.update(runId, { activities })
    this.broadcastRunsChanged(true)
  }

  private updateStep(
    runId: string,
    index: number,
    patch: Partial<CriticalThinkingStepState>
  ): void {
    const run = this.requireRun(runId)
    criticalThinkingStore.update(runId, {
      steps: run.steps.map((step, stepIndex) =>
        stepIndex === index ? { ...step, ...patch } : step
      )
    })
  }

  private updatePlanProgress(
    runId: string,
    index: number,
    status: Plan['steps'][number]['status']
  ): void {
    const run = this.requireRun(runId)
    if (!run.plan) return
    criticalThinkingStore.update(runId, {
      plan: {
        ...run.plan,
        steps: run.plan.steps.map((step, stepIndex) =>
          stepIndex === index ? { ...step, status } : step
        ),
        updatedAt: Date.now()
      }
    })
  }

  private finishPlanningStop(
    id: string,
    stats: GenerationStats | null,
    stopReason: GenerationStopReason | undefined
  ): void {
    this.finish(id, stopReason === 'user' ? 'stopped' : 'failed', {
      stats,
      lastError: stoppedReasonMessage(stopReason)
    })
  }

  private finish(
    id: string,
    status: Extract<CriticalThinkingRun['status'], 'completed' | 'partial' | 'stopped' | 'failed'>,
    patch: Partial<CriticalThinkingRun>
  ): void {
    criticalThinkingStore.update(id, { ...patch, status })
    this.broadcastRunsChanged()
  }

  private requireRun(id: string): CriticalThinkingRun {
    const run = criticalThinkingStore.get(id)
    if (!run) throw new Error('Critical Thinking run not found.')
    return run
  }

  private assertSearchReady(): void {
    const settings = settingsStore.get()
    if (!settings.tools.enabled)
      throw new Error('Enable AI tools in Settings before starting Critical Thinking.')
    if (!createSearchProvider(settings.webSearch)) {
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
      if (!window.isDestroyed())
        window.webContents.send(IpcChannel.CriticalThinking.stream, { runId, token })
    }
  }

  private broadcastRunsChanged(throttled = false): void {
    if (throttled) {
      if (this.broadcastTimer) return
      this.broadcastTimer = setTimeout(() => {
        this.broadcastTimer = null
        this.broadcastRunsChanged()
      }, 150)
      return
    }
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer)
      this.broadcastTimer = null
    }
    const runs = criticalThinkingStore.list()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed())
        window.webContents.send(IpcChannel.CriticalThinking.runsChanged, runs)
    }
  }

  private clearActiveRun(): void {
    this.activeRunId = null
    this.activeController = null
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

function createStepStates(plan: Plan): CriticalThinkingStepState[] {
  return plan.steps.map((step) => ({
    id: step.id,
    title: step.title,
    status: 'pending',
    attempts: 0,
    evidenceIds: [],
    finding: '',
    uncertainties: []
  }))
}

function latestPlan(calls: ToolCall[]): Plan | null {
  return calls.filter((call) => call.status === 'success' && call.plan).at(-1)?.plan ?? null
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
  return { tokens, durationMs, tokensPerSecond: durationMs > 0 ? tokens / (durationMs / 1000) : 0 }
}

function pickGenerationResult(result: RunGenerationResult): {
  stats: GenerationStats
  stopped: boolean
  stopReason?: GenerationStopReason
} {
  return { stats: result.stats, stopped: result.stopped, stopReason: result.stopReason }
}

function generateMessageId(): string {
  return `critical_msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Critical Thinking failed.'
}

function stoppedReasonMessage(stopReason: GenerationStopReason | undefined): string {
  switch (stopReason) {
    case 'fixed-context-limit':
      return 'The model instructions and required tools do not fit in the configured context window.'
    case 'context-limit':
      return 'This step reached the model context limit; saved evidence can be resumed.'
    case 'loop-guard':
    case 'no-progress':
      return 'The model repeated actions without making progress; saved evidence can be resumed.'
    case 'rounds-exhausted':
      return 'This step reached its provider-round budget; saved evidence can be resumed.'
    case 'tool-limit':
      return 'This step reached its tool-call budget; saved evidence can be resumed.'
    case 'time-limit':
      return 'This step reached its time budget; saved evidence can be resumed.'
    case 'yielded':
      return 'This workflow yielded after saving its progress.'
    default:
      return 'Research was stopped.'
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export const criticalThinkingService = new CriticalThinkingService()
