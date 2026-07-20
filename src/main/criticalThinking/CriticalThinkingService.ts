import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type {
  ApproveCriticalThinkingRequest,
  CreateCriticalThinkingRequest,
  CriticalThinkingActivity,
  CriticalThinkingProvider,
  CriticalThinkingRoundState,
  CriticalThinkingRun,
  CriticalThinkingStepState
} from '@shared/criticalThinking.types'
import type { ChatRequest } from '@shared/chat.types'
import type { GenerationStats, GenerationStopReason } from '@shared/chat.types'
import type { Plan } from '@shared/plan.types'
import type { ToolCall } from '@shared/tools.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import {
  runGeneration,
  type RunGenerationIo,
  type RunGenerationResult
} from '../chat/runGeneration'
import { CRITICAL_THINKING_STEP_BUDGET } from '../chat/GenerationBudget'
import { GENERATION_IN_PROGRESS_ERROR, llamaService } from '../llama/LlamaService'
import { settingsStore } from '../settings/SettingsStore'
import { showToastWindow } from '../toastWindow'
import { createSearchProvider } from '../tools/search'
import { fetchUrlEvidence } from '../tools/webTools'
import { createLogger } from '../utils/logger'
import { criticalThinkingEvidenceStore } from './CriticalThinkingEvidenceStore'
import { criticalThinkingStore } from './CriticalThinkingStore'
import {
  buildCriticalThinkingPlanPrompt,
  buildCriticalThinkingPlanRetryPrompt,
  buildCriticalThinkingRepairPrompt,
  buildCriticalThinkingSynthesisPrompt
} from './criticalThinkingPrompts'
import {
  buildEvidencePacket,
  renderResearchCitations,
  validateResearchReport
} from './criticalThinkingEvidence'
import { mergeSources, sourcesFromArtifact } from './criticalThinkingSources'
import { canonicalResearchUrl } from './criticalThinkingUrl'
import {
  CriticalThinkingResearchRunner,
  type CriticalThinkingResearchStepResult,
  type CriticalThinkingRunUsage
} from './CriticalThinkingResearchRunner'
import {
  boundPromptItems,
  criticalThinkingContextTokens,
  criticalThinkingSynthesisLimits,
  truncatePromptText
} from './criticalThinkingSynthesisBudget'

const log = createLogger('critical-thinking-service')
const MAX_QUESTION_CHARS = 8_000
const MAX_PLAN_STEPS = 12
const MAX_PLAN_STEP_CHARS = 240
const MAX_ACTIVITIES = 240
const LOCAL_BUSY_RETRY_MS = 500
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
    this.activeController.abort('user')
  }

  async delete(id: string): Promise<void> {
    if (this.activeRunId === id) throw new Error('Stop this run before deleting it.')
    this.requireRun(id)
    criticalThinkingStore.delete(id)
    criticalThinkingEvidenceStore.delete(id)
    // The renderer removes the run only after this IPC call resolves. Flush
    // both stores first so an immediate app close cannot resurrect metadata or
    // leave a sidecar that the UI already reported as deleted.
    await Promise.all([criticalThinkingStore.flush(), criticalThinkingEvidenceStore.flush()])
    this.broadcastRunsChanged()
  }

  stopAll(): void {
    this.activeController?.abort('user')
  }

  private async runPlanning(run: CriticalThinkingRun): Promise<void> {
    this.activeRunId = run.id
    const controller = new AbortController()
    this.activeController = controller
    let combinedStats: GenerationStats | null = null

    try {
      const planningLimits = criticalThinkingSynthesisLimits(
        criticalThinkingContextTokens(run.provider, run.model, llamaService.getState().contextSize)
      )
      const planningQuestion = truncatePromptText(
        run.question,
        Math.min(6_000, Math.floor(planningLimits.maxPromptChars * 0.35))
      )
      let result = await this.runPlanTurn(
        run,
        buildCriticalThinkingPlanPrompt(planningQuestion),
        controller.signal
      )
      combinedStats = addStats(combinedStats, result.stats)
      let plan = latestPlan(result.calls)
      if (result.stopped) return this.finishPlanningStop(run.id, combinedStats, result.stopReason)

      if (!plan) {
        result = await this.runPlanTurn(
          run,
          buildCriticalThinkingPlanRetryPrompt(planningQuestion),
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
      try {
        await criticalThinkingStore.flush()
      } catch (error) {
        log.error('Failed to flush Critical Thinking planning state:', run.id, error)
        this.reportPersistenceFailure(run.id)
      } finally {
        this.clearActiveRun()
      }
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
    const result = await this.runIsolatedGeneration(
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
        sessionMode: 'isolated',
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
    if (!initialRun.plan) {
      this.finish(initialRun.id, 'failed', {
        lastError: 'A reviewed research plan is required.'
      })
      return
    }
    this.activeRunId = initialRun.id
    const controller = new AbortController()
    this.activeController = controller
    let totalTimedOut = false
    const usage: CriticalThinkingRunUsage = { rounds: 0, searches: 0, fetches: 0 }
    const totalTimer = setTimeout(() => {
      totalTimedOut = true
      controller.abort('time-limit')
    }, initialRun.researchPolicy.maxRunMs)

    try {
      // Approval may have queued deletion of evidence from an earlier plan.
      // Make that reset durable before rebuilding run-side references.
      await criticalThinkingEvidenceStore.flush()
      this.reconcileEvidenceReferences(initialRun.id)

      for (let index = 0; index < initialRun.steps.length; index++) {
        const current = this.requireRun(initialRun.id)
        const step = current.steps[index]
        if (step.status === 'completed') continue
        if (controller.signal.aborted) break
        const result = await this.runResearchStep(current, index, controller.signal, usage)
        this.updatePlanProgress(
          current.id,
          index,
          result.status === 'completed' ? 'completed' : 'pending'
        )
        this.broadcastRunsChanged()
        if (result.stopped) break
        if (result.runBudgetReached) break
      }

      if (controller.signal.aborted) {
        if (totalTimedOut) this.markRunTimeLimit(initialRun.id)
        this.finish(initialRun.id, totalTimedOut ? 'partial' : 'stopped', {
          lastError: totalTimedOut
            ? 'The investigation reached its research-attempt time budget and can be resumed.'
            : 'Research was stopped. You can resume from the saved evidence.'
        })
        return
      }
      this.reconcileEvidenceReferences(initialRun.id)
      await this.runSynthesis(this.requireRun(initialRun.id), controller.signal)
    } catch (error) {
      log.error('Critical Thinking research failed:', initialRun.id, error)
      if (controller.signal.aborted && totalTimedOut) this.markRunTimeLimit(initialRun.id)
      this.finish(
        initialRun.id,
        controller.signal.aborted ? (totalTimedOut ? 'partial' : 'stopped') : 'failed',
        {
          lastError: controller.signal.aborted
            ? totalTimedOut
              ? 'The investigation reached its research-attempt time budget and can be resumed.'
              : 'Research was stopped. You can resume from the saved evidence.'
            : errorMessage(error)
        }
      )
    } finally {
      clearTimeout(totalTimer)
      try {
        await criticalThinkingEvidenceStore.flush()
        await criticalThinkingStore.flush()
      } catch (error) {
        log.error('Failed to flush final Critical Thinking state:', initialRun.id, error)
        this.reportPersistenceFailure(initialRun.id)
      } finally {
        this.clearActiveRun()
      }
    }
  }

  private async runResearchStep(
    run: CriticalThinkingRun,
    index: number,
    signal: AbortSignal,
    usage: CriticalThinkingRunUsage
  ): Promise<CriticalThinkingResearchStepResult> {
    const step = run.steps[index]
    this.updateStep(run.id, index, {
      status: 'researching',
      attempts: step.attempts + 1,
      terminationReason: undefined
    })
    this.updatePlanProgress(run.id, index, 'in_progress')
    criticalThinkingStore.update(run.id, { status: 'researching', currentStep: index })
    this.broadcastRunsChanged()

    const settings = settingsStore.get()
    const searchProvider = createSearchProvider(settings.webSearch)
    if (!searchProvider) throw new Error('A web search provider is required for research.')

    const runner = new CriticalThinkingResearchRunner({
      getRun: () => this.requireRun(run.id),
      listArtifacts: () => criticalThinkingEvidenceStore.list(run.id),
      runModel: (_phase, prompt, maxTokens, phaseSignal) =>
        this.runToolFreeTurn(this.requireRun(run.id), prompt, phaseSignal, false, maxTokens),
      search: async (query, resultCount, searchSignal) => ({
        provider: settings.webSearch.provider,
        results: await searchProvider.search(query, resultCount, searchSignal)
      }),
      fetch: (url, focus, fetchSignal) => fetchUrlEvidence(url, focus, fetchSignal),
      recordArtifact: (artifact, roundId) => this.recordArtifact(run.id, index, roundId, artifact),
      updateStep: (patch) => this.updateStep(run.id, index, patch),
      appendRound: (round) => this.appendRound(run.id, index, round),
      updateRound: (roundId, patch) => this.updateRound(run.id, index, roundId, patch),
      recordActivity: (activity) => this.recordActivity(run.id, activity),
      addStats: (stats) => {
        const current = this.requireRun(run.id)
        criticalThinkingStore.update(run.id, { stats: addStats(current.stats, stats) })
      },
      checkpoint: async () => {
        // Evidence must become durable before the run claims that a phase or
        // round completed; orphaned evidence is recoverable, missing claimed
        // evidence is not.
        await criticalThinkingEvidenceStore.flush()
        this.reconcileEvidenceReferences(run.id)
        await criticalThinkingStore.flush()
      },
      contextTokens: criticalThinkingContextTokens(
        run.provider,
        run.model,
        llamaService.getState().contextSize
      )
    })
    const result = await runner.run(signal, usage)
    this.broadcastRunsChanged()
    return result
  }

  private async runSynthesis(run: CriticalThinkingRun, signal: AbortSignal): Promise<void> {
    const artifacts = criticalThinkingEvidenceStore.list(run.id)
    const verifiedSources = run.sources.filter((source) => source.verified)
    const limits = criticalThinkingSynthesisLimits(
      criticalThinkingContextTokens(run.provider, run.model, llamaService.getState().contextSize)
    )
    const question = truncatePromptText(run.question, limits.maxQuestionChars)
    const plan = boundPlanForPrompt(run.plan!, limits.maxPlanChars)
    const findings = boundPromptItems(
      run.steps.map((step) => step.finding),
      limits.maxFindingChars
    )
    const promptWithoutEvidence = buildCriticalThinkingSynthesisPrompt(question, plan, findings, '')
    const evidencePacket = buildEvidencePacket(
      artifacts,
      run.sources,
      Math.max(
        0,
        Math.min(limits.maxEvidenceChars, limits.maxPromptChars - promptWithoutEvidence.length)
      )
    )
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
      buildCriticalThinkingSynthesisPrompt(question, plan, findings, evidencePacket),
      signal,
      true,
      limits.maxOutputTokens
    )
    let draft = synthesis.content.trim()
    let stats = addStats(run.stats, synthesis.stats)
    if (synthesis.stopped || !draft) {
      const stopReason = signalStopReason(signal, synthesis.stopReason)
      this.finish(run.id, stopReason === 'user' ? 'stopped' : 'partial', {
        report: draft,
        stats,
        lastError: stoppedReasonMessage(stopReason)
      })
      return
    }

    criticalThinkingStore.update(run.id, { status: 'validating', report: draft, stats })
    this.broadcastRunsChanged()
    let validation = validateResearchReport(draft, artifacts, run.sources)
    let repairStopReason: GenerationStopReason | undefined
    if (!validation.valid) {
      const repairIssues = boundPromptItems(
        validation.issues,
        Math.min(3_000, Math.floor(limits.maxPromptChars * 0.12))
      )
      const repairBase = buildCriticalThinkingRepairPrompt('', repairIssues, '')
      const repairRemaining = Math.max(0, limits.maxPromptChars - repairBase.length)
      const repairEvidence = buildEvidencePacket(
        artifacts,
        run.sources,
        Math.min(limits.maxEvidenceChars, Math.floor(repairRemaining * 0.58))
      )
      const repairDraft = truncatePromptText(
        draft,
        Math.max(0, repairRemaining - repairEvidence.length)
      )
      const repair = await this.runToolFreeTurn(
        run,
        buildCriticalThinkingRepairPrompt(repairDraft, repairIssues, repairEvidence),
        signal,
        false,
        limits.maxOutputTokens
      )
      stats = addStats(stats, repair.stats)
      if (repair.stopped) {
        repairStopReason = signalStopReason(signal, repair.stopReason) ?? 'yielded'
      } else if (repair.content.trim()) {
        // A stopped repair may contain an incomplete stream. Keep the original
        // complete draft unless the repair itself completed.
        draft = repair.content.trim()
      }
      validation = validateResearchReport(draft, artifacts, run.sources)
    }

    const report = renderResearchCitations(draft, run.sources)
    const limitedSteps = run.steps.some((step) => step.status !== 'completed')
    const status =
      repairStopReason === 'user'
        ? 'stopped'
        : validation.valid && !limitedSteps && !repairStopReason
          ? 'completed'
          : 'partial'
    this.finish(run.id, status, {
      report,
      stats,
      plan: status === 'completed' ? completePlan(run.plan) : run.plan,
      lastError: repairStopReason
        ? `Report repair stopped early. ${stoppedReasonMessage(repairStopReason)}`
        : validation.valid
          ? limitedSteps
            ? limitedResearchMessage(run.steps)
            : null
          : truncate(
              `Citation validation remained incomplete: ${validation.issues.join(' ')}`,
              2_000
            )
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
    stream: boolean,
    maxTokens: number
  ): Promise<RunGenerationResult> {
    return this.runIsolatedGeneration(
      {
        conversationId: run.id,
        messageId: generateMessageId(),
        projectId: null,
        history: [],
        prompt,
        options: { temperature: 0.2, maxTokens }
      },
      {
        signal,
        sessionMode: 'isolated',
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

  /**
   * Every orchestration phase gets an empty logical transcript and a fresh
   * local native session. If another local turn owns the single model engine,
   * wait without converting a transient busy condition into a failed run.
   */
  private async runIsolatedGeneration(
    request: ChatRequest,
    io: RunGenerationIo
  ): Promise<RunGenerationResult> {
    const provider = io.providerOverride?.provider ?? settingsStore.get().provider.active
    let reportedBusy = false
    while (true) {
      if (io.signal?.aborted) {
        return stoppedGeneration(signalStopReason(io.signal, 'user') ?? 'user')
      }
      try {
        return await runGeneration(request, { ...io, sessionMode: 'isolated' })
      } catch (error) {
        const busy =
          provider === 'local' &&
          error instanceof Error &&
          error.message === GENERATION_IN_PROGRESS_ERROR
        if (!busy) throw error
        if (!reportedBusy) {
          reportedBusy = true
          log.info('Local model is busy; Critical Thinking is waiting for the active turn.')
        }
        if (!(await waitForRetry(io.signal, LOCAL_BUSY_RETRY_MS))) {
          return stoppedGeneration(signalStopReason(io.signal, 'user') ?? 'user')
        }
      }
    }
  }

  private async recordArtifact(
    runId: string,
    stepIndex: number,
    roundId: string,
    artifact: ToolArtifact
  ): Promise<void> {
    const inserted = criticalThinkingEvidenceStore.record(runId, artifact)
    if (!inserted) return

    // Make the full evidence durable before runs.json is allowed to reference
    // its ID. If this write fails, the runner stops at the current phase and
    // leaves the last successfully checkpointed state resumable.
    await criticalThinkingEvidenceStore.flush()

    const run = this.requireRun(runId)
    const steps = run.steps.map((step, index) => {
      if (index !== stepIndex) return step
      return {
        ...step,
        evidenceIds: [...new Set([...step.evidenceIds, artifact.id])],
        rounds: step.rounds.map((round) =>
          round.id === roundId
            ? { ...round, evidenceIds: [...new Set([...round.evidenceIds, artifact.id])] }
            : round
        )
      }
    })
    criticalThinkingStore.update(runId, {
      // Search results remain durable leads in the sidecar. Keeping only
      // fetched pages in the compact source index prevents early snippets
      // from exhausting the source cap before later verified evidence arrives.
      sources:
        artifact.kind === 'web-fetch' && artifact.passages.length > 0
          ? mergeSources(run.sources, sourcesFromArtifact(artifact))
          : run.sources,
      evidenceCount: run.evidenceCount + 1,
      steps
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
    const activities = (
      existing
        ? run.activities.map((item) => (item.id === call.id ? activity : item))
        : [...run.activities, activity]
    ).slice(-MAX_ACTIVITIES)
    criticalThinkingStore.update(runId, { activities })
    this.broadcastRunsChanged(true)
  }

  private recordActivity(runId: string, activity: CriticalThinkingActivity): void {
    const run = criticalThinkingStore.get(runId)
    if (!run) return
    const existing = run.activities.some((item) => item.id === activity.id)
    const activities = (
      existing
        ? run.activities.map((item) => (item.id === activity.id ? activity : item))
        : [...run.activities, activity]
    ).slice(-MAX_ACTIVITIES)
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

  private appendRound(runId: string, stepIndex: number, round: CriticalThinkingRoundState): void {
    const run = this.requireRun(runId)
    criticalThinkingStore.update(runId, {
      steps: run.steps.map((step, index) =>
        index === stepIndex ? { ...step, rounds: [...step.rounds, round] } : step
      )
    })
  }

  private updateRound(
    runId: string,
    stepIndex: number,
    roundId: string,
    patch: Partial<CriticalThinkingRoundState>
  ): void {
    const run = this.requireRun(runId)
    criticalThinkingStore.update(runId, {
      steps: run.steps.map((step, index) =>
        index === stepIndex
          ? {
              ...step,
              rounds: step.rounds.map((round) =>
                round.id === roundId ? { ...round, ...patch } : round
              )
            }
          : step
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

  /** Repair run-side references from the authoritative evidence sidecar at checkpoints. */
  private reconcileEvidenceReferences(runId: string): void {
    const run = this.requireRun(runId)
    const artifacts = criticalThinkingEvidenceStore.list(runId)
    const artifactIds = new Set(artifacts.map((artifact) => artifact.id))
    const artifactsByStep = new Map<string, string[]>()
    const artifactsByRound = new Map<string, string[]>()
    const fetchedUrls = new Set<string>()
    for (const artifact of artifacts) {
      if (artifact.research) {
        appendMapValue(artifactsByStep, artifact.research.stepId, artifact.id)
        appendMapValue(artifactsByRound, artifact.research.roundId, artifact.id)
      }
      if (artifact.kind === 'web-fetch' && artifact.passages.length > 0) {
        fetchedUrls.add(canonicalResearchUrl(artifact.finalUrl))
      }
    }
    const reconciledSources = artifacts
      .filter((artifact) => artifact.kind === 'web-fetch' && artifact.passages.length > 0)
      .reduce(
        (sources, artifact) => mergeSources(sources, sourcesFromArtifact(artifact)),
        run.sources
          .filter((source) => fetchedUrls.has(canonicalResearchUrl(source.url)))
          .map((source) => ({
            ...source,
            verified: source.verified && fetchedUrls.has(canonicalResearchUrl(source.url))
          }))
      )
    criticalThinkingStore.update(runId, {
      evidenceCount: artifacts.length,
      sources: reconciledSources,
      steps: run.steps.map((step) => ({
        ...step,
        evidenceIds: uniqueExistingIds(
          [...step.evidenceIds, ...(artifactsByStep.get(step.id) ?? [])],
          artifactIds
        ),
        rounds: step.rounds.map((round) => ({
          ...round,
          evidenceIds: uniqueExistingIds(
            [...round.evidenceIds, ...(artifactsByRound.get(round.id) ?? [])],
            artifactIds
          )
        }))
      }))
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

  private reportPersistenceFailure(id: string): void {
    const run = criticalThinkingStore.get(id)
    if (!run) return
    criticalThinkingStore.update(id, {
      status: run.report ? 'partial' : 'failed',
      lastError:
        'Anodex could not save the latest research checkpoint. Check available disk space and file permissions before retrying.'
    })
    this.broadcastRunsChanged()
  }

  private markRunTimeLimit(id: string): void {
    const run = criticalThinkingStore.get(id)
    if (!run || run.steps.length === 0) return
    const fromCurrent = run.steps.findIndex(
      (step, index) => index >= run.currentStep && step.status !== 'completed'
    )
    const index =
      fromCurrent >= 0 ? fromCurrent : run.steps.findIndex((step) => step.status !== 'completed')
    if (index < 0) return
    criticalThinkingStore.update(id, {
      steps: run.steps.map((step, stepIndex) => {
        if (stepIndex !== index || step.status === 'completed') return step
        const latestRoundId = step.rounds.at(-1)?.id
        return {
          ...step,
          status: 'limited',
          terminationReason: 'time-limit',
          rounds: step.rounds.map((round) =>
            round.id === latestRoundId && round.status !== 'completed'
              ? {
                  ...round,
                  status: 'limited',
                  terminationReason: 'time-limit',
                  completedAt: Date.now()
                }
              : round
          )
        }
      })
    })
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
    uncertainties: [],
    rounds: []
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

function boundPlanForPrompt(plan: Plan, maxChars: number): Plan {
  const titles = boundPromptItems(
    plan.steps.map((step) => step.title),
    maxChars
  )
  return {
    ...plan,
    steps: plan.steps.slice(0, titles.length).map((step, index) => ({
      ...step,
      title: titles[index]
    }))
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

function signalStopReason(
  signal: AbortSignal | undefined,
  fallback: GenerationStopReason | undefined
): GenerationStopReason | undefined {
  if (!signal?.aborted) return fallback
  return signal.reason === 'time-limit' ? 'time-limit' : (fallback ?? 'user')
}

function stoppedReasonMessage(stopReason: GenerationStopReason | undefined): string {
  switch (stopReason) {
    case 'fixed-context-limit':
      return 'The model instructions and required tools do not fit in the configured context window.'
    case 'context-limit':
      return 'This step reached the model context limit; saved evidence can be resumed.'
    case 'context-shift-limit':
      return 'This step reached its context-compaction budget; saved evidence can be resumed.'
    case 'loop-guard':
    case 'no-progress':
      return 'The model repeated actions without making progress; saved evidence can be resumed.'
    case 'rounds-exhausted':
      return 'This step reached its provider-round budget; saved evidence can be resumed.'
    case 'tool-limit':
      return 'This step reached its tool-call budget; saved evidence can be resumed.'
    case 'token-limit':
      return 'This step reached its safe local output-token limit; saved evidence can be resumed.'
    case 'time-limit':
      return 'This step reached its time budget; saved evidence can be resumed.'
    case 'yielded':
      return 'This workflow yielded after saving its progress.'
    default:
      return 'Research was stopped.'
  }
}

function limitedResearchMessage(steps: CriticalThinkingStepState[]): string {
  const reasons = new Set(steps.map((step) => step.terminationReason).filter(Boolean))
  if (reasons.has('evidence-limit')) {
    return 'This investigation reached its lifetime verified-evidence limit. The report uses the retained evidence; start a narrower new investigation to research additional material.'
  }
  if (reasons.has('tool-limit')) {
    return 'This research attempt reached its bounded search or page-reading budget. The report uses the saved evidence; Resume can investigate remaining gaps.'
  }
  if (reasons.has('rounds-exhausted')) {
    return 'Some steps reached their adaptive-round budget. The report uses the saved evidence; Resume can investigate remaining gaps.'
  }
  if (reasons.has('no-progress')) {
    return 'Some steps could not find additional verified evidence after repeated searches. The report uses the evidence that was available.'
  }
  if (reasons.has('time-limit')) {
    return 'Some research steps reached their time budget. The report uses the saved evidence; Resume can continue the unfinished rounds.'
  }
  return 'Some research steps ended with unresolved gaps; this report uses the evidence collected.'
}

function stoppedGeneration(stopReason: GenerationStopReason): RunGenerationResult {
  return {
    content: '',
    stats: { tokens: 0, durationMs: 0, tokensPerSecond: 0 },
    stopped: true,
    stopReason
  }
}

function waitForRetry(signal: AbortSignal | undefined, delayMs: number): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function appendMapValue(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key) ?? []
  values.push(value)
  map.set(key, values)
}

function uniqueExistingIds(values: string[], existing: Set<string>): string[] {
  return [...new Set(values.filter((value) => existing.has(value)))]
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export const criticalThinkingService = new CriticalThinkingService()
