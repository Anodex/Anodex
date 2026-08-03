import { randomUUID } from 'node:crypto'
import { providerMaxResponseTokens } from '@shared/maxResponseTokens'
import { IpcChannel } from '@shared/ipc'
import { broadcastToWindows } from '../broadcast'
import type {
  ApproveCriticalThinkingRequest,
  CreateCriticalThinkingRequest,
  CriticalThinkingActivity,
  CriticalThinkingProvider,
  CriticalThinkingRoundState,
  CriticalThinkingRun,
  CriticalThinkingSynthesisAttemptDiagnostic,
  CriticalThinkingSynthesisDiagnostics,
  CriticalThinkingSynthesisStage,
  CriticalThinkingStepState
} from '@shared/criticalThinking.types'
import type { ChatRequest } from '@shared/chat.types'
import type { GenerationStats, GenerationStopReason } from '@shared/chat.types'
import type { Plan } from '@shared/plan.types'
import type { ProviderSettings } from '@shared/settings.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import {
  runGeneration,
  type RunGenerationIo,
  type RunGenerationResult
} from '../chat/runGeneration'
import { CRITICAL_THINKING_STEP_BUDGET } from '../chat/GenerationBudget'
import { llamaService } from '../llama/LlamaService'
import {
  isOpenAiCompatibleProviderId,
  OPEN_AI_COMPATIBLE_CONFIGS
} from '../llm/cloudProviderConfigs'
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
  buildCriticalThinkingChartPrompt,
  buildCriticalThinkingConsistencyPrompt,
  buildCriticalThinkingRepairPrompt,
  buildCriticalThinkingOverviewPrompt,
  buildCriticalThinkingSectionPrompt,
  buildCriticalThinkingSectionRepairPrompt,
  buildCriticalThinkingSynthesisPrompt
} from './criticalThinkingPrompts'
import {
  buildEvidencePacket,
  renderResearchCitations,
  validateResearchReport
} from './criticalThinkingEvidence'
import {
  buildDeterministicFallbackReport,
  buildDeterministicStepSection
} from './criticalThinkingFallbackReport'
import {
  chooseBetterReportCandidate,
  evaluateReportCandidate,
  type ReportCandidate
} from './criticalThinkingReportCandidate'
import { parseResearchPlan } from './criticalThinkingResearchOutput'
import { mergeSources, sourcesFromArtifact } from './criticalThinkingSources'
import {
  addStats,
  isRecoverableContentStopReason,
  runStructuredPhase,
  signalStopReason
} from './criticalThinkingStructuredPhase'
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
  truncatePromptText,
  type CriticalThinkingSynthesisLimits
} from './criticalThinkingSynthesisBudget'
import {
  CRITICAL_THINKING_CHART_SELECTION_SCHEMA,
  CRITICAL_THINKING_CONSISTENCY_SCHEMA,
  CRITICAL_THINKING_OVERVIEW_SCHEMA,
  CRITICAL_THINKING_PLAN_SCHEMA,
  criticalThinkingAssessmentSchema,
  criticalThinkingQuerySchema
} from './criticalThinkingSchemas'
import {
  assembleHierarchicalReport,
  chooseBetterHierarchicalSection,
  evaluateHierarchicalSection,
  parseHierarchicalOverview,
  type HierarchicalSectionCandidate
} from './criticalThinkingHierarchicalReport'
import {
  appendCriticalThinkingCharts,
  parseCriticalThinkingChartSelection,
  reportHasEvidenceChart,
  reportHasQuantitativeProse
} from './criticalThinkingCharts'
import {
  applyCriticalThinkingConsistencyCorrections,
  parseCriticalThinkingConsistencyReview,
  sectionsNeedConsistencyReview
} from './criticalThinkingConsistency'
import { headlessConfirm } from '../tools/headlessConfirm'

const log = createLogger('critical-thinking-service')
const MAX_QUESTION_CHARS = 8_000
const MAX_PLAN_STEPS = 12
const MAX_PLAN_STEP_CHARS = 240
const MAX_ACTIVITIES = 240
/**
 * How the run's time budget is split. Synthesis is several bounded model
 * calls — a draft, a repair, one pass per section, a consistency review, an
 * overview — so on a local model it needs real minutes, not leftovers.
 */
const SYNTHESIS_BUDGET_SHARE = 0.3
const MIN_SYNTHESIS_WINDOW_MS = 8 * 60_000
const MIN_RESEARCH_WINDOW_MS = 5 * 60_000
const SYNTHESIS_BUDGET = { ...CRITICAL_THINKING_STEP_BUDGET, maxTools: 0 }

/**
 * The cloud model to pin on a new run, mirroring `runGeneration.ts`'s
 * `activeModelDescriptor` resolution — `null` for `local` (the loaded model
 * can change between the run's creation and when it actually generates, so
 * local runs deliberately track "whatever's loaded" rather than a pinned id).
 */
function resolveCriticalThinkingModel(
  provider: CriticalThinkingProvider,
  providerSettings: ProviderSettings
): string | null {
  if (provider === 'local') return null
  if (provider === 'anthropic') return providerSettings.anthropic.model
  if (provider === 'openai') return providerSettings.openai.model
  if (provider === 'azure') return providerSettings.azure.deploymentName || null
  if (isOpenAiCompatibleProviderId(provider)) return providerSettings[provider].model
  return null
}

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
    const model = resolveCriticalThinkingModel(provider, settings.provider)
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
      synthesisDiagnostics: null,
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
      synthesisDiagnostics: null,
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

  /**
   * Planning is a tool-free structured phase: the model returns bounded JSON
   * for the service to parse and validate, rather than calling `write_plan`
   * through the native function-calling loop. A successful tool call there
   * was not a terminal workflow boundary — the installed session API keeps
   * generating after it — so a plan that arrived just before a recoverable
   * token/context-shift limit was discarded even though it was complete and
   * valid. `runStructuredPhase` fixes that ordering once, for every phase.
   */
  private async runPlanning(run: CriticalThinkingRun): Promise<void> {
    this.activeRunId = run.id
    const controller = new AbortController()
    this.activeController = controller

    try {
      const planningLimits = criticalThinkingSynthesisLimits(
        criticalThinkingContextTokens(run.provider, run.model, llamaService.getState().contextSize)
      )
      const planningQuestion = truncatePromptText(
        run.question,
        Math.min(6_000, Math.floor(planningLimits.maxPromptChars * 0.35))
      )

      const phase = await runStructuredPhase<Plan>(
        buildCriticalThinkingPlanPrompt(planningQuestion),
        controller.signal,
        {
          generate: (prompt) =>
            this.runToolFreeTurn(
              run,
              prompt,
              controller.signal,
              false,
              Math.min(1_536, planningLimits.maxOutputTokens),
              undefined,
              CRITICAL_THINKING_PLAN_SCHEMA
            ),
          parse: (content) => {
            const parsed = parseResearchPlan(content)
            return { value: parsed.plan, valid: parsed.valid, issues: parsed.issues }
          },
          buildRepairPrompt: (_previousContent, issues) =>
            buildCriticalThinkingPlanRetryPrompt(planningQuestion, issues)
        }
      )

      if (phase.userStopped) {
        return this.finishPlanningStop(run.id, phase.stats, phase.stopReason)
      }
      if (!phase.valid || !phase.value) {
        // A defined stopReason here means an orchestration-level limit (not
        // the user) cut planning short before it produced anything parseable
        // — surface that specific, already-worded reason. No stopReason at
        // all means the model completed normally but still produced unusable
        // output, which is a distinct, clearer-question kind of failure.
        if (phase.stopReason) {
          return this.finishPlanningStop(run.id, phase.stats, phase.stopReason)
        }
        this.finish(run.id, 'failed', {
          stats: phase.stats,
          lastError: 'The model could not produce a valid research plan. Try a clearer question.'
        })
        return
      }

      const plan = phase.value
      // Exactly one planning activity, regardless of whether a repair
      // attempt ran — the model-call detail lives in `phase`, not here.
      this.recordActivity(run.id, {
        id: randomUUID(),
        kind: 'planning',
        label: `Plan: ${truncate(plan.title, 60)}`,
        status: 'success',
        detail: `${plan.steps.length} steps`,
        createdAt: Date.now()
      })
      criticalThinkingStore.update(run.id, {
        status: 'needs-review',
        plan,
        steps: createStepStates(plan),
        stats: phase.stats,
        lastError: null
      })
      // Make the review-ready transition durable before telling the
      // renderer — a crash between the in-memory update and the disk write
      // must not leave the UI showing an approvable plan that didn't survive
      // a restart. A flush failure here falls through to the catch below and
      // reports an explicit failure instead of a false needs-review.
      await criticalThinkingStore.flush()
      this.broadcastRunsChanged()
    } catch (error) {
      log.error('Critical Thinking planning failed:', run.id, error)
      this.finish(run.id, controller.signal.aborted ? 'stopped' : 'failed', {
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
    // Writing the report is the payoff for every minute of research, so it
    // gets a guaranteed share of the run's budget instead of whatever happens
    // to be left. Observed live: research consumed nearly the whole hour and
    // synthesis was cut off mid-repair, with its overview and chart stages
    // both ending on `time-limit` — an hour of gathering, then no room to
    // write it up. Research is bounded to the remainder so the configured
    // budget still means what it says end to end.
    const startedAt = Date.now()
    const runBudgetMs = initialRun.researchPolicy.maxRunMs
    const synthesisReserveMs = Math.max(
      MIN_SYNTHESIS_WINDOW_MS,
      Math.floor(runBudgetMs * SYNTHESIS_BUDGET_SHARE)
    )
    const researchBudgetMs = Math.max(MIN_RESEARCH_WINDOW_MS, runBudgetMs - synthesisReserveMs)
    let totalTimer = setTimeout(() => {
      totalTimedOut = true
      controller.abort('time-limit')
    }, researchBudgetMs)

    try {
      // Approval may have queued deletion of evidence from an earlier plan.
      // Make that reset durable before rebuilding run-side references.
      await criticalThinkingEvidenceStore.flush()
      this.reconcileEvidenceReferences(initialRun.id)

      await this.runResearchWaves(initialRun.id, controller.signal, usage)

      if (controller.signal.aborted) {
        this.finishAbortedResearch(initialRun.id, totalTimedOut)
        return
      }
      this.reconcileEvidenceReferences(initialRun.id)
      // Research is done; re-arm the clock for synthesis. It gets whatever is
      // left of the run budget, never less than the reserve — so finishing
      // research early buys the report more room, and overrunning research
      // cannot take the report's room away.
      clearTimeout(totalTimer)
      totalTimer = setTimeout(
        () => {
          totalTimedOut = true
          controller.abort('time-limit')
        },
        Math.max(synthesisReserveMs, runBudgetMs - (Date.now() - startedAt))
      )
      await this.runSynthesis(this.requireRun(initialRun.id), controller.signal)
    } catch (error) {
      log.error('Critical Thinking research failed:', initialRun.id, error)
      if (controller.signal.aborted) {
        this.finishAbortedResearch(initialRun.id, totalTimedOut)
      } else {
        // A real error mid-research or synthesis. Don't discard the whole
        // investigation — salvage the best report the verified evidence can
        // support, falling back to an actionable failure only when nothing
        // was gathered at all.
        this.finishWithSalvagedReport(initialRun.id, 'failed', errorMessage(error))
      }
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

  /**
   * Breadth-first: every not-yet-completed/limited step gets one research
   * round before any step gets a second, so a handful of early steps can no
   * longer exhaust the run's lifetime round/search/fetch budget before later
   * approved steps are ever attempted (docs/CONTEXT_ADAPTIVE_RUNTIME_RECOVERY_HANDOFF.md, P0-D).
   * Round-robin naturally guarantees round N for every step before round N+1
   * for any step, without needing separate reservation bookkeeping.
   */
  private async runResearchWaves(
    runId: string,
    signal: AbortSignal,
    usage: CriticalThinkingRunUsage
  ): Promise<void> {
    while (true) {
      const run = this.requireRun(runId)
      if (
        usage.rounds >= run.researchPolicy.maxRoundsPerRun ||
        usage.searches >= run.researchPolicy.maxSearchesPerRun ||
        usage.fetches >= run.researchPolicy.maxFetchesPerRun
      ) {
        return
      }
      const pendingIndexes = run.steps.flatMap((step, index) =>
        step.status === 'completed' || step.status === 'limited' ? [] : [index]
      )
      if (pendingIndexes.length === 0) return

      let attemptedAny = false
      for (const index of pendingIndexes) {
        if (signal.aborted) return
        const current = this.requireRun(runId)
        const step = current.steps[index]
        if (step.status === 'completed' || step.status === 'limited') continue

        attemptedAny = true
        const result = await this.runResearchStep(current, index, signal, usage, 1)
        this.updatePlanProgress(
          runId,
          index,
          result.status === 'completed' ? 'completed' : 'pending'
        )
        this.broadcastRunsChanged()
        if (result.stopped) return
        if (result.runBudgetReached) return
      }
      if (!attemptedAny) return
    }
  }

  private async runResearchStep(
    run: CriticalThinkingRun,
    index: number,
    signal: AbortSignal,
    usage: CriticalThinkingRunUsage,
    maxNewRoundsThisCall: number
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
      runModel: (phase, prompt, maxTokens, phaseSignal) =>
        this.runToolFreeTurn(
          this.requireRun(run.id),
          prompt,
          phaseSignal,
          false,
          maxTokens,
          undefined,
          phase === 'query'
            ? criticalThinkingQuerySchema(run.researchPolicy.maxQueriesPerRound)
            : criticalThinkingAssessmentSchema(run.researchPolicy.maxQueriesPerRound)
        ),
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
    const result = await runner.run(signal, usage, maxNewRoundsThisCall)
    this.broadcastRunsChanged()
    return result
  }

  private async runSynthesis(run: CriticalThinkingRun, signal: AbortSignal): Promise<void> {
    const artifacts = criticalThinkingEvidenceStore.list(run.id)
    const verifiedSources = run.sources.filter((source) => source.verified)
    const limits = criticalThinkingSynthesisLimits(
      criticalThinkingContextTokens(run.provider, run.model, llamaService.getState().contextSize),
      run.provider === 'local'
        ? providerMaxResponseTokens(settingsStore.get().provider, 'local')
        : undefined
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

    let synthesisDiagnostics: CriticalThinkingSynthesisDiagnostics = {
      startedAt: Date.now(),
      completedAt: null,
      verifiedSourceCount: verifiedSources.length,
      evidencePacketChars: evidencePacket.length,
      strategy: 'single-pass',
      selectedStage: null,
      attempts: []
    }
    const recordDiagnostic = (attempt: CriticalThinkingSynthesisAttemptDiagnostic): void => {
      synthesisDiagnostics = {
        ...synthesisDiagnostics,
        attempts: [...synthesisDiagnostics.attempts, attempt].slice(-32)
      }
      criticalThinkingStore.update(run.id, { synthesisDiagnostics })
    }

    criticalThinkingStore.update(run.id, {
      status: 'synthesizing',
      report: '',
      synthesisDiagnostics
    })
    this.broadcastRunsChanged()
    const synthesis = await this.runToolFreeTurn(
      run,
      buildCriticalThinkingSynthesisPrompt(question, plan, findings, evidencePacket),
      signal,
      true,
      limits.maxOutputTokens,
      limits.thoughtTokens
    )
    const draft = synthesis.content.trim()
    const thinkingChars = synthesis.thinking?.length
    let stats = addStats(run.stats, synthesis.stats)
    const synthesisStopReason = signalStopReason(signal, synthesis.stopReason)
    const synthesisUserStopped = synthesisStopReason === 'user'
    // A recoverable output/context limit (e.g. token-limit) does not by
    // itself mean the draft is unusable — validate it first and only then
    // decide, instead of discarding a possibly-complete report because
    // generation happened to end on that limit. An orchestration-level stop
    // (time/tool/round budget) or an empty draft skips straight to Partial,
    // matching the pre-existing behavior for those reasons.
    const draftWorthValidating =
      draft.length > 0 && isRecoverableContentStopReason(synthesisStopReason)
    if (synthesisUserStopped || !draftWorthValidating) {
      recordDiagnostic(
        rawSynthesisDiagnostic('draft', draft, synthesisStopReason, undefined, thinkingChars)
      )
      synthesisDiagnostics = { ...synthesisDiagnostics, completedAt: Date.now() }
      // A synthesis that wrote nothing at all is not a reason to throw away
      // the investigation behind it. Observed directly: a run holding 53
      // verified sources and 119 evidence artifacts finished with an empty
      // report because the model spent its entire output budget on hidden
      // reasoning and produced zero visible characters (`thinkingChars`
      // above records that, so the next occurrence is diagnosable from the
      // stored run alone). The deterministic, citation-checked fallback is
      // built from evidence rather than model prose, so it is available
      // whether or not the model ever wrote a word — use it instead of
      // finishing with `report: ''`. A user Stop stays resumable, and a
      // non-empty draft keeps its existing path.
      if (!synthesisUserStopped && !draft) {
        criticalThinkingStore.update(run.id, { stats, synthesisDiagnostics })
        this.finishWithSalvagedReport(run.id, 'partial', stoppedReasonMessage(synthesisStopReason))
        return
      }
      this.finish(run.id, synthesisUserStopped ? 'stopped' : 'partial', {
        report: draft,
        stats,
        synthesisDiagnostics,
        lastError: stoppedReasonMessage(synthesisStopReason)
      })
      return
    }

    criticalThinkingStore.update(run.id, { status: 'validating', report: draft, stats })
    this.broadcastRunsChanged()
    const approvedStepCount = run.steps.length
    let candidate: ReportCandidate = evaluateReportCandidate(
      draft,
      artifacts,
      run.sources,
      approvedStepCount
    )
    let selectedStage: CriticalThinkingSynthesisStage = 'draft'
    recordDiagnostic(
      reportCandidateDiagnostic('draft', candidate, synthesisStopReason, undefined, thinkingChars)
    )
    let repairStopReason: GenerationStopReason | undefined
    if (!candidate.overallValid) {
      const repairIssues = boundPromptItems(
        candidate.issues,
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
        limits.maxOutputTokens,
        limits.thoughtTokens
      )
      stats = addStats(stats, repair.stats)
      const repairStopReasonCandidate = signalStopReason(signal, repair.stopReason)
      if (repair.stopped && !isRecoverableContentStopReason(repairStopReasonCandidate)) {
        // A genuine user Stop, or an orchestration-level limit, with nothing
        // recoverable to check — keep the original draft and remember why.
        repairStopReason = repairStopReasonCandidate ?? 'yielded'
        recordDiagnostic(
          rawSynthesisDiagnostic(
            'repair',
            repair.content,
            repairStopReasonCandidate,
            undefined,
            repair.thinking?.length
          )
        )
      } else if (repair.content.trim()) {
        // Either the repair completed cleanly, or it stopped on a
        // recoverable output/context limit but may still be a complete,
        // valid replacement — score both drafts and keep whichever is
        // actually better rather than assuming the repair improved things
        // just because it is nonempty (P0-F: a worse repair must never
        // silently overwrite a better original).
        const repairedCandidate = evaluateReportCandidate(
          repair.content,
          artifacts,
          run.sources,
          approvedStepCount
        )
        recordDiagnostic(
          reportCandidateDiagnostic(
            'repair',
            repairedCandidate,
            repairStopReasonCandidate,
            undefined,
            repair.thinking?.length
          )
        )
        const selected = chooseBetterReportCandidate(candidate, repairedCandidate)
        if (selected === repairedCandidate) selectedStage = 'repair'
        candidate = selected
      }
    }

    const stepsWithEvidence = run.steps.filter((step) => step.evidenceIds.length > 0).length
    if (
      reportNeedsHierarchicalRecovery(candidate, stepsWithEvidence) &&
      repairStopReason !== 'user' &&
      run.provider === 'local' &&
      stepsWithEvidence > 1
    ) {
      synthesisDiagnostics = { ...synthesisDiagnostics, strategy: 'hierarchical-recovery' }
      criticalThinkingStore.update(run.id, { synthesisDiagnostics })
      const hierarchical = await this.runHierarchicalSynthesis(
        run,
        artifacts,
        question,
        limits,
        signal
      )
      stats = addStats(stats, hierarchical.stats)
      for (const diagnostic of hierarchical.attempts) recordDiagnostic(diagnostic)
      if (hierarchical.stopReason && !isRecoverableContentStopReason(hierarchical.stopReason)) {
        repairStopReason = hierarchical.stopReason
      }
      if (hierarchical.candidate) {
        const selected = chooseBetterReportCandidate(candidate, hierarchical.candidate)
        if (selected === hierarchical.candidate) selectedStage = 'hierarchical-report'
        candidate = selected
      }
    }

    if (
      candidate.usable &&
      repairStopReason !== 'user' &&
      run.provider === 'local' &&
      reportHasQuantitativeProse(candidate.content) &&
      !reportHasEvidenceChart(candidate.content)
    ) {
      try {
        const chartRecovery = await this.runChartRecovery(
          run,
          artifacts,
          question,
          candidate,
          limits,
          signal
        )
        stats = addStats(stats, chartRecovery.stats)
        recordDiagnostic(chartRecovery.attempt)
        if (chartRecovery.candidate) {
          candidate = chartRecovery.candidate
          selectedStage = 'chart'
        }
        if (chartRecovery.stopReason === 'user') repairStopReason = 'user'
      } catch (error) {
        log.warn('Critical Thinking optional chart selection failed', {
          runId: run.id,
          error: errorMessage(error)
        })
        recordDiagnostic({
          stage: 'chart',
          contentChars: 0,
          content: '',
          safe: true,
          usable: false,
          valid: true,
          citedBlockCount: 0,
          issues: [`Optional chart selection failed: ${truncate(errorMessage(error), 240)}`]
        })
        if (signal.aborted && signal.reason === 'user') repairStopReason = 'user'
      }
    }

    // Fall back to the deterministic report ONLY when the model's own report
    // is not usable — it fabricated (a citation-safety violation) or produced
    // too little cited substance (P0-H: the exact live failure was a
    // 175-character uncited fragment). A safe, substantial report that merely
    // misses a section heading or leaves a framing sentence uncited is a
    // better answer than the blunt bullet-dump fallback, so it is kept and the
    // run reported as `partial`, not replaced.
    if (!candidate.usable && repairStopReason !== 'user') {
      // Diagnostic: which issues sank the model's own report, so a recurring
      // fallback is debuggable from the run log. Logged before the fallback is
      // scored in; the issues are the model draft's, not the fallback's.
      log.warn('Critical Thinking synthesis not usable; using deterministic fallback', {
        runId: run.id,
        safe: candidate.safe,
        issues: candidate.issues,
        citedSubstantiveBlockCount: candidate.citedSubstantiveBlockCount,
        draftLength: candidate.length
      })
      const fallbackContent = buildDeterministicFallbackReport(
        run.plan?.title ?? run.question,
        run.steps,
        artifacts,
        run.sources
      )
      const fallbackCandidate = evaluateReportCandidate(
        fallbackContent,
        artifacts,
        run.sources,
        stepsWithEvidence
      )
      recordDiagnostic(reportCandidateDiagnostic('deterministic-fallback', fallbackCandidate))
      const selected = chooseBetterReportCandidate(candidate, fallbackCandidate)
      if (selected === fallbackCandidate) {
        selectedStage = 'deterministic-fallback'
        synthesisDiagnostics = { ...synthesisDiagnostics, strategy: 'deterministic-fallback' }
      }
      candidate = selected
    } else if (!candidate.overallValid) {
      // Kept a safe-but-imperfect model report — record why it's `partial`.
      log.info('Critical Thinking kept a safe model report with coverage gaps', {
        runId: run.id,
        issues: candidate.issues,
        citedSubstantiveBlockCount: candidate.citedSubstantiveBlockCount
      })
    }

    const report = renderResearchCitations(candidate.content, run.sources)
    const limitedSteps = run.steps.some((step) => step.status !== 'completed')
    const status =
      repairStopReason === 'user'
        ? 'stopped'
        : candidate.overallValid && !limitedSteps && !repairStopReason
          ? 'completed'
          : 'partial'
    synthesisDiagnostics = {
      ...synthesisDiagnostics,
      completedAt: Date.now(),
      selectedStage
    }
    this.finish(run.id, status, {
      report,
      stats,
      synthesisDiagnostics,
      plan: status === 'completed' ? completePlan(run.plan) : run.plan,
      lastError: reportLastError(candidate, limitedSteps, repairStopReason, run.steps)
    })
    showToastWindow({
      title: status === 'completed' ? 'Critical Thinking complete' : 'Partial research ready',
      body: truncate(run.question, 140)
    })
  }

  /**
   * Recover a broad local-model report by solving one bounded evidence section
   * at a time, then asking for only the cross-section summary. This keeps each
   * generation small enough for local contexts while preserving the same
   * citation and fabrication checks as the one-shot path.
   */
  private async runHierarchicalSynthesis(
    run: CriticalThinkingRun,
    artifacts: ToolArtifact[],
    question: string,
    limits: CriticalThinkingSynthesisLimits,
    signal: AbortSignal
  ): Promise<{
    candidate: ReportCandidate | null
    stats: GenerationStats
    attempts: CriticalThinkingSynthesisAttemptDiagnostic[]
    stopReason?: GenerationStopReason
  }> {
    const attempts: CriticalThinkingSynthesisAttemptDiagnostic[] = []
    const sections = new Map<string, string>()
    let stats: GenerationStats = { tokens: 0, durationMs: 0, tokensPerSecond: 0 }
    /**
     * The sections finished so far, assembled into a report.
     *
     * Every stage below can end on a non-recoverable stop — the run's time
     * limit lands mid-way far more often than not, since hierarchical recovery
     * only runs after a draft has already failed and eaten part of the budget.
     * Those exits used to return `candidate: null`, discarding every section
     * already written and citation-checked, so a run that produced five good
     * sections out of six contributed nothing and fell back to the bullet-dump.
     *
     * Assembling early is safe: `assembleHierarchicalReport` already skips
     * steps with no section and already synthesises its own overview when it
     * has none, and the caller scores whatever comes back against the existing
     * draft — so a thin partial simply loses rather than replacing a better
     * report.
     */
    const salvageSections = (): ReportCandidate | null => {
      if (sections.size === 0) return null
      return evaluateReportCandidate(
        assembleHierarchicalReport({
          title: run.plan?.title ?? run.question,
          steps: run.steps,
          sections,
          overview: null,
          sources: run.sources
        }),
        artifacts,
        run.sources,
        run.steps.length
      )
    }
    // A section's prompt is small — one step's evidence, capped at 18,000
    // characters — so the context has room to spare here. The old 3,072
    // ceiling was below what this model spends on hidden reasoning alone,
    // which is why four of six sections in a live run returned zero visible
    // characters and fell back to raw excerpt dumps.
    const sectionOutputTokens = Math.max(
      512,
      Math.min(8_192, Math.floor(limits.maxOutputTokens * 0.65))
    )
    const sectionThoughtTokens = Math.min(
      limits.thoughtTokens,
      Math.floor(sectionOutputTokens * 0.25)
    )

    for (const step of run.steps) {
      const evidenceIds = new Set(step.evidenceIds)
      const stepArtifacts = artifacts.filter(
        (artifact) => evidenceIds.has(artifact.id) || artifact.research?.stepId === step.id
      )
      const basePrompt = buildCriticalThinkingSectionPrompt(
        question,
        step.title,
        step.finding,
        step.uncertainties,
        ''
      )
      const evidencePacket = buildEvidencePacket(
        stepArtifacts,
        run.sources,
        Math.max(
          0,
          Math.min(limits.maxEvidenceChars, 18_000, limits.maxPromptChars - basePrompt.length)
        )
      )
      if (!evidencePacket) continue

      const sectionResult = await this.runToolFreeTurn(
        run,
        buildCriticalThinkingSectionPrompt(
          question,
          step.title,
          step.finding,
          step.uncertainties,
          evidencePacket
        ),
        signal,
        false,
        sectionOutputTokens,
        sectionThoughtTokens
      )
      stats = addStats(stats, sectionResult.stats)
      const sectionStopReason = signalStopReason(signal, sectionResult.stopReason)
      let sectionCandidate = evaluateHierarchicalSection(
        sectionResult.content,
        stepArtifacts,
        run.sources
      )
      attempts.push(
        hierarchicalSectionDiagnostic(
          'section',
          sectionCandidate,
          sectionStopReason,
          step.id,
          sectionResult.thinking?.length
        )
      )

      if (
        !sectionCandidate.valid &&
        isRecoverableContentStopReason(sectionStopReason) &&
        !signal.aborted
      ) {
        const repairIssues = boundPromptItems(sectionCandidate.issues, 1_500)
        const repairBase = buildCriticalThinkingSectionRepairPrompt('', repairIssues, '')
        const repairRemaining = Math.max(0, limits.maxPromptChars - repairBase.length)
        const repairEvidence = buildEvidencePacket(
          stepArtifacts,
          run.sources,
          Math.min(18_000, Math.floor(repairRemaining * 0.62))
        )
        const repairDraft = truncatePromptText(
          sectionCandidate.content,
          Math.max(0, repairRemaining - repairEvidence.length)
        )
        const repaired = await this.runToolFreeTurn(
          run,
          buildCriticalThinkingSectionRepairPrompt(repairDraft, repairIssues, repairEvidence),
          signal,
          false,
          sectionOutputTokens,
          sectionThoughtTokens
        )
        stats = addStats(stats, repaired.stats)
        const repairedStopReason = signalStopReason(signal, repaired.stopReason)
        const repairedCandidate = evaluateHierarchicalSection(
          repaired.content,
          stepArtifacts,
          run.sources
        )
        attempts.push(
          hierarchicalSectionDiagnostic(
            'section-repair',
            repairedCandidate,
            repairedStopReason,
            step.id,
            repaired.thinking?.length
          )
        )
        sectionCandidate = chooseBetterHierarchicalSection(sectionCandidate, repairedCandidate)
        if (repairedStopReason && !isRecoverableContentStopReason(repairedStopReason)) {
          return { candidate: salvageSections(), stats, attempts, stopReason: repairedStopReason }
        }
      }

      if (!sectionCandidate.usable) {
        const fallbackCandidate = evaluateHierarchicalSection(
          buildDeterministicStepSection(step, stepArtifacts, run.sources),
          stepArtifacts,
          run.sources
        )
        attempts.push(
          hierarchicalSectionDiagnostic('section-fallback', fallbackCandidate, undefined, step.id)
        )
        sectionCandidate = chooseBetterHierarchicalSection(sectionCandidate, fallbackCandidate)
      }
      if (sectionCandidate.usable) sections.set(step.id, sectionCandidate.content)
      if (sectionStopReason && !isRecoverableContentStopReason(sectionStopReason)) {
        return { candidate: salvageSections(), stats, attempts, stopReason: sectionStopReason }
      }
    }

    if (sections.size === 0) return { candidate: null, stats, attempts }

    if (sectionsNeedConsistencyReview(sections)) {
      const consistencyItems = run.steps.flatMap((step) => {
        const section = sections.get(step.id)
        return section ? [`[stepId=${step.id}]\n## ${step.title}\n\n${section}`] : []
      })
      const consistencyBase = buildCriticalThinkingConsistencyPrompt(question, '', '')
      const consistencySections = boundPromptItems(
        consistencyItems,
        Math.max(0, Math.min(28_000, limits.maxPromptChars - consistencyBase.length))
      ).join('\n\n')
      const evidenceBudget = Math.max(
        0,
        Math.min(
          18_000,
          limits.maxPromptChars - consistencyBase.length - consistencySections.length
        )
      )
      const consistencyEvidence = buildEvidencePacket(artifacts, run.sources, evidenceBudget)
      const consistencyOutputTokens = Math.max(
        384,
        Math.min(3_072, Math.floor(limits.maxOutputTokens * 0.3))
      )
      const consistencyResult = await this.runToolFreeTurn(
        run,
        buildCriticalThinkingConsistencyPrompt(question, consistencySections, consistencyEvidence),
        signal,
        false,
        consistencyOutputTokens,
        Math.min(limits.thoughtTokens, Math.floor(consistencyOutputTokens * 0.2)),
        CRITICAL_THINKING_CONSISTENCY_SCHEMA
      )
      stats = addStats(stats, consistencyResult.stats)
      const consistencyStopReason = signalStopReason(signal, consistencyResult.stopReason)
      const corrections = parseCriticalThinkingConsistencyReview(consistencyResult.content)
      if (corrections) {
        const applied = applyCriticalThinkingConsistencyCorrections(
          sections,
          corrections,
          artifacts,
          run.sources
        )
        sections.clear()
        for (const [stepId, section] of applied.sections) sections.set(stepId, section)
        attempts.push(
          hierarchicalSectionDiagnostic(
            'consistency',
            {
              content: consistencyResult.content.trim(),
              safe: true,
              valid: true,
              usable: true,
              citedBlockCount: applied.accepted,
              issues: applied.issues
            },
            consistencyStopReason
          )
        )
      } else {
        attempts.push(
          rawSynthesisDiagnostic('consistency', consistencyResult.content, consistencyStopReason)
        )
      }
      if (consistencyStopReason && !isRecoverableContentStopReason(consistencyStopReason)) {
        return { candidate: salvageSections(), stats, attempts, stopReason: consistencyStopReason }
      }
    }

    const sectionItems = run.steps.flatMap((step) => {
      const section = sections.get(step.id)
      return section ? [`## ${step.title}\n\n${section}`] : []
    })
    const overviewBase = buildCriticalThinkingOverviewPrompt(question, '')
    const boundedSections = boundPromptItems(
      sectionItems,
      Math.max(0, Math.min(36_000, limits.maxPromptChars - overviewBase.length))
    ).join('\n\n')
    // The overview returned zero characters on a live run: its 2,048
    // ceiling left nothing after hidden reasoning, so the report fell back to
    // a deterministic summary and conclusion.
    const overviewOutputTokens = Math.max(
      384,
      Math.min(4_096, Math.floor(limits.maxOutputTokens * 0.4))
    )
    const overviewResult = await this.runToolFreeTurn(
      run,
      buildCriticalThinkingOverviewPrompt(question, boundedSections),
      signal,
      false,
      overviewOutputTokens,
      Math.min(limits.thoughtTokens, Math.floor(overviewOutputTokens * 0.2)),
      CRITICAL_THINKING_OVERVIEW_SCHEMA
    )
    stats = addStats(stats, overviewResult.stats)
    const overviewStopReason = signalStopReason(signal, overviewResult.stopReason)
    const overview = parseHierarchicalOverview(overviewResult.content)
    if (overview) {
      const overviewCandidate = evaluateHierarchicalSection(
        `${overview.executiveSummary}\n\n${overview.conclusion}`,
        artifacts,
        run.sources
      )
      attempts.push(
        hierarchicalSectionDiagnostic(
          'overview',
          overviewCandidate,
          overviewStopReason,
          undefined,
          overviewResult.thinking?.length
        )
      )
    } else {
      attempts.push(rawSynthesisDiagnostic('overview', overviewResult.content, overviewStopReason))
    }
    if (overviewStopReason && !isRecoverableContentStopReason(overviewStopReason)) {
      return { candidate: salvageSections(), stats, attempts, stopReason: overviewStopReason }
    }

    const baseReport = assembleHierarchicalReport({
      title: run.plan?.title ?? run.question,
      steps: run.steps,
      sections,
      overview: null,
      sources: run.sources
    })
    let candidate = evaluateReportCandidate(baseReport, artifacts, run.sources, run.steps.length)
    if (overview) {
      const reportWithOverview = assembleHierarchicalReport({
        title: run.plan?.title ?? run.question,
        steps: run.steps,
        sections,
        overview,
        sources: run.sources
      })
      candidate = chooseBetterReportCandidate(
        candidate,
        evaluateReportCandidate(reportWithOverview, artifacts, run.sources, run.steps.length)
      )
    }
    attempts.push(reportCandidateDiagnostic('hierarchical-report', candidate))
    return { candidate, stats, attempts }
  }

  private async runChartRecovery(
    run: CriticalThinkingRun,
    artifacts: ToolArtifact[],
    question: string,
    report: ReportCandidate,
    limits: CriticalThinkingSynthesisLimits,
    signal: AbortSignal
  ): Promise<{
    candidate: ReportCandidate | null
    stats: GenerationStats
    attempt: CriticalThinkingSynthesisAttemptDiagnostic
    stopReason?: GenerationStopReason
  }> {
    const boundedReport = truncatePromptText(
      report.content,
      Math.min(20_000, Math.floor(limits.maxPromptChars * 0.38))
    )
    const promptBase = buildCriticalThinkingChartPrompt(question, boundedReport, '')
    const chartEvidence = buildEvidencePacket(
      artifacts,
      run.sources,
      Math.max(0, Math.min(limits.maxEvidenceChars, limits.maxPromptChars - promptBase.length))
    )
    const outputTokens = Math.max(384, Math.min(1_536, Math.floor(limits.maxOutputTokens * 0.3)))
    const result = await this.runToolFreeTurn(
      run,
      buildCriticalThinkingChartPrompt(question, boundedReport, chartEvidence),
      signal,
      false,
      outputTokens,
      Math.min(limits.thoughtTokens, Math.floor(outputTokens * 0.2)),
      CRITICAL_THINKING_CHART_SELECTION_SCHEMA
    )
    const stopReason = signalStopReason(signal, result.stopReason)
    const chartBlocks = parseCriticalThinkingChartSelection(result.content)
    if (!chartBlocks) {
      return {
        candidate: null,
        stats: result.stats,
        attempt: rawSynthesisDiagnostic('chart', result.content, stopReason),
        ...(stopReason ? { stopReason } : {})
      }
    }
    if (chartBlocks.length === 0) {
      return {
        candidate: null,
        stats: result.stats,
        attempt: {
          stage: 'chart',
          contentChars: result.content.trim().length,
          content: result.content.trim().slice(0, MAX_SYNTHESIS_DIAGNOSTIC_CONTENT_CHARS),
          ...(stopReason ? { stopReason } : {}),
          safe: true,
          usable: false,
          valid: true,
          citedBlockCount: 0,
          issues: []
        },
        ...(stopReason ? { stopReason } : {})
      }
    }

    const chartContent = chartBlocks.join('\n\n')
    const validation = validateResearchReport(chartContent, artifacts, run.sources)
    const safe = validation.safetyIssues.length === 0
    const attempt: CriticalThinkingSynthesisAttemptDiagnostic = {
      stage: 'chart',
      contentChars: chartContent.length,
      content: chartContent.slice(0, MAX_SYNTHESIS_DIAGNOSTIC_CONTENT_CHARS),
      ...(stopReason ? { stopReason } : {}),
      safe,
      usable: safe && validation.valid,
      valid: validation.valid,
      citedBlockCount: chartBlocks.length,
      issues: validation.issues.slice(0, 24)
    }
    if (!validation.valid) {
      return {
        candidate: null,
        stats: result.stats,
        attempt,
        ...(stopReason ? { stopReason } : {})
      }
    }

    const augmented = evaluateReportCandidate(
      appendCriticalThinkingCharts(report.content, chartBlocks),
      artifacts,
      run.sources,
      run.steps.length
    )
    return {
      candidate: augmented.safe ? augmented : null,
      stats: result.stats,
      attempt,
      ...(stopReason ? { stopReason } : {})
    }
  }

  /**
   * One bounded model call for a research or synthesis phase, with a single
   * retry that disables hidden reasoning outright when the first attempt
   * produced no visible text at all.
   *
   * A requested `thoughtTokens` sub-budget asks the engine to close the
   * reasoning segment partway through; a budget of zero prevents the segment
   * from ever opening, which is a stronger and simpler guarantee. Phases here
   * already pass a sub-budget, yet live runs still produced attempts with
   * zero characters against a token-limit stop — several sections, the
   * overview, and a whole synthesis that returned an empty report from 53
   * verified sources. Rather than depend on the partway close alone, treat an
   * empty visible reply as proof that reasoning consumed the call, and spend
   * one more call getting an answer instead of returning nothing. Retried at
   * most once, local provider only (no other provider exposes the budget),
   * and never after a user Stop.
   */
  private async runToolFreeTurn(
    run: CriticalThinkingRun,
    prompt: string,
    signal: AbortSignal,
    stream: boolean,
    maxTokens: number,
    thoughtTokens?: number,
    jsonSchema?: Record<string, unknown>
  ): Promise<RunGenerationResult> {
    const first = await this.generateToolFreeTurn(
      run,
      prompt,
      signal,
      stream,
      maxTokens,
      thoughtTokens,
      jsonSchema
    )
    if (
      run.provider !== 'local' ||
      thoughtTokens === 0 ||
      signal.aborted ||
      first.content.trim() !== '' ||
      !isRecoverableContentStopReason(signalStopReason(signal, first.stopReason)) ||
      first.stopReason === undefined
    ) {
      return first
    }
    log.warn('Critical Thinking phase produced no visible output; retrying without reasoning.', {
      runId: run.id,
      maxTokens,
      thoughtTokens,
      thinkingChars: first.thinking?.length ?? 0,
      stopReason: first.stopReason
    })
    const retried = await this.generateToolFreeTurn(
      run,
      prompt,
      signal,
      stream,
      maxTokens,
      0,
      jsonSchema
    )
    // Both calls really ran, so both are charged to the run's token stats.
    return { ...retried, stats: addStats(first.stats, retried.stats) }
  }

  private async generateToolFreeTurn(
    run: CriticalThinkingRun,
    prompt: string,
    signal: AbortSignal,
    stream: boolean,
    maxTokens: number,
    thoughtTokens?: number,
    jsonSchema?: Record<string, unknown>
  ): Promise<RunGenerationResult> {
    return this.runIsolatedGeneration(
      {
        conversationId: run.id,
        messageId: generateMessageId(),
        projectId: null,
        history: [],
        prompt,
        options: { temperature: 0.2, maxTokens, thoughtTokens, jsonSchema }
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
        // `enabledTools` is empty, so nothing can ask — but route through the
        // shared unattended policy anyway rather than leaving a blanket
        // approve-everything behind, in case this phase ever gains a tool.
        confirm: headlessConfirm
      }
    )
  }

  /**
   * Every orchestration phase gets an empty logical transcript and a fresh
   * local native session.
   *
   * This used to poll: a busy local engine threw a distinct "already
   * generating" error, and this slept 500ms and retried until it got in.
   * `LlamaService.generate()` now holds the model lock for the whole turn, so a
   * contending caller simply waits its turn in FIFO order — the outcome the
   * polling existed to produce, without the sleep, the error round-trip, or the
   * chance of losing its place to whoever asked next.
   */
  private async runIsolatedGeneration(
    request: ChatRequest,
    io: RunGenerationIo
  ): Promise<RunGenerationResult> {
    if (io.signal?.aborted) {
      return stoppedGeneration(signalStopReason(io.signal, 'user') ?? 'user')
    }
    return runGeneration(request, { ...io, sessionMode: 'isolated' })
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

  /**
   * Terminate a run whose research phase was aborted. A time-limit abort still
   * salvages a report from whatever was verified (the deterministic fallback is
   * a synchronous, no-model-call assembly, so it's safe even past the budget);
   * a genuine user Stop stays resumable with no forced report, respecting the
   * intent to pause.
   */
  private finishAbortedResearch(runId: string, totalTimedOut: boolean): void {
    if (totalTimedOut) {
      this.markRunTimeLimit(runId)
      this.finishWithSalvagedReport(
        runId,
        'partial',
        'The investigation reached its research-attempt time budget.'
      )
      return
    }
    this.finish(runId, 'stopped', {
      lastError: 'Research was stopped. You can resume from the saved evidence.'
    })
  }

  /**
   * Finish a run that ended without a validated synthesis report by building
   * the best report the gathered evidence can support, instead of discarding an
   * entire investigation because one round or the synthesis step failed. When
   * any source was verified this emits the same deterministic, citation-checked
   * fallback report `runSynthesis` uses, marked `partial`; only a run that
   * gathered nothing citable reports an outright, actionable failure — never a
   * fabricated one. `reason` is appended to the surfaced message so the user
   * knows why it stopped short. `emptyStatus` is what to report when there is
   * no evidence to salvage (`'failed'` for a real error, `'partial'` for a
   * clean early stop such as a time-out).
   */
  private finishWithSalvagedReport(
    runId: string,
    emptyStatus: 'failed' | 'partial',
    reason: string
  ): void {
    const run = criticalThinkingStore.get(runId)
    if (!run) return
    const artifacts = criticalThinkingEvidenceStore.list(runId)
    const verifiedSources = run.sources.filter((source) => source.verified)

    if (verifiedSources.length === 0) {
      // Nothing citable was gathered — an honest, actionable message beats a
      // fabricated report or a bare "failed".
      this.finish(runId, emptyStatus, {
        lastError:
          emptyStatus === 'failed'
            ? `Critical Thinking could not gather any usable web sources. ${reason} Check your web search provider and internet connection, then try again.`
            : `Research ended before any source could be verified. ${reason}`
      })
      return
    }

    const stepsWithEvidence = run.steps.filter((step) => step.evidenceIds.length > 0).length
    const fallbackContent = buildDeterministicFallbackReport(
      run.plan?.title ?? run.question,
      run.steps,
      artifacts,
      run.sources
    )
    const candidate = evaluateReportCandidate(
      fallbackContent,
      artifacts,
      run.sources,
      stepsWithEvidence
    )
    const report = renderResearchCitations(candidate.content, run.sources)
    const synthesisDiagnostics = run.synthesisDiagnostics
      ? {
          ...run.synthesisDiagnostics,
          completedAt: Date.now(),
          strategy: 'deterministic-fallback' as const,
          selectedStage: 'deterministic-fallback' as const,
          attempts: [
            ...run.synthesisDiagnostics.attempts,
            reportCandidateDiagnostic('deterministic-fallback', candidate)
          ].slice(-32)
        }
      : null
    this.finish(runId, 'partial', {
      report,
      plan: run.plan,
      synthesisDiagnostics,
      lastError: `This report was assembled from the ${verifiedSources.length} source${
        verifiedSources.length === 1 ? '' : 's'
      } verified before research stopped early. ${reason}`
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
    if (provider === 'local') {
      if (llamaService.getState().status !== 'ready') {
        throw new Error('Load a local model before starting Critical Thinking.')
      }
      return
    }
    if (provider === 'anthropic' && !settings.provider.anthropic.apiKey.trim()) {
      throw new Error('Connect Anthropic in Settings → AI & Models before starting.')
    }
    if (provider === 'openai' && !settings.provider.openai.apiKey.trim()) {
      throw new Error('Connect OpenAI in Settings → AI & Models before starting.')
    }
    if (provider === 'azure') {
      const azure = settings.provider.azure
      if (!azure.apiKey.trim() || !azure.resourceName.trim() || !azure.deploymentName.trim()) {
        throw new Error('Connect Azure OpenAI in Settings → AI & Models before starting.')
      }
    }
    if (isOpenAiCompatibleProviderId(provider) && !settings.provider[provider].apiKey.trim()) {
      throw new Error(
        `Connect ${OPEN_AI_COMPATIBLE_CONFIGS[provider].displayName} in Settings → AI & Models before starting.`
      )
    }
  }

  private broadcastStream(runId: string, token: string): void {
    broadcastToWindows(IpcChannel.CriticalThinking.stream, { runId, token })
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
    broadcastToWindows(IpcChannel.CriticalThinking.runsChanged, runs)
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

/**
 * Retained draft text per synthesis attempt. `runs.json` is rewritten whole on
 * every progress update, and the hierarchical path alone records ~19 attempts
 * per run — at the previous 24,000 this let a single run carry most of a
 * megabyte of stored drafts, re-serialized on each activity. 12,000 still
 * shows a draft's structure, headings, and citation density, which is what
 * these attempts are read for.
 */
const MAX_SYNTHESIS_DIAGNOSTIC_CONTENT_CHARS = 12_000

function reportCandidateDiagnostic(
  stage: CriticalThinkingSynthesisStage,
  candidate: ReportCandidate,
  stopReason?: GenerationStopReason,
  stepId?: string,
  thinkingChars?: number
): CriticalThinkingSynthesisAttemptDiagnostic {
  return {
    stage,
    ...(stepId ? { stepId } : {}),
    contentChars: candidate.content.length,
    content: candidate.content.slice(0, MAX_SYNTHESIS_DIAGNOSTIC_CONTENT_CHARS),
    ...(thinkingChars !== undefined ? { thinkingChars } : {}),
    ...(stopReason ? { stopReason } : {}),
    safe: candidate.safe,
    usable: candidate.usable,
    valid: candidate.overallValid,
    citedBlockCount: candidate.citedSubstantiveBlockCount,
    issues: candidate.issues.slice(0, 24)
  }
}

function reportNeedsHierarchicalRecovery(
  candidate: ReportCandidate,
  stepsWithEvidence: number
): boolean {
  if (!candidate.usable) return true
  const expectedCitedBlocks = Math.max(1, stepsWithEvidence)
  const minimumDetailedChars = Math.max(1_200, stepsWithEvidence * 450)
  return (
    candidate.citedSubstantiveBlockCount < expectedCitedBlocks ||
    candidate.length < minimumDetailedChars
  )
}

function hierarchicalSectionDiagnostic(
  stage: 'section' | 'section-repair' | 'section-fallback' | 'consistency' | 'overview',
  candidate: HierarchicalSectionCandidate,
  stopReason?: GenerationStopReason,
  stepId?: string,
  thinkingChars?: number
): CriticalThinkingSynthesisAttemptDiagnostic {
  return {
    stage,
    ...(stepId ? { stepId } : {}),
    contentChars: candidate.content.length,
    content: candidate.content.slice(0, MAX_SYNTHESIS_DIAGNOSTIC_CONTENT_CHARS),
    ...(thinkingChars !== undefined ? { thinkingChars } : {}),
    ...(stopReason ? { stopReason } : {}),
    safe: candidate.safe,
    usable: candidate.usable,
    valid: candidate.valid,
    citedBlockCount: candidate.citedBlockCount,
    issues: candidate.issues.slice(0, 24)
  }
}

function rawSynthesisDiagnostic(
  stage: CriticalThinkingSynthesisStage,
  content: string,
  stopReason?: GenerationStopReason,
  stepId?: string,
  thinkingChars?: number
): CriticalThinkingSynthesisAttemptDiagnostic {
  const trimmed = content.trim()
  return {
    stage,
    ...(stepId ? { stepId } : {}),
    contentChars: trimmed.length,
    content: trimmed.slice(0, MAX_SYNTHESIS_DIAGNOSTIC_CONTENT_CHARS),
    ...(thinkingChars !== undefined ? { thinkingChars } : {}),
    ...(stopReason ? { stopReason } : {}),
    safe: false,
    usable: false,
    valid: false,
    citedBlockCount: 0,
    issues: ['The model output could not be validated as a complete structured response.']
  }
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

/**
 * The banner message for a finished synthesis. A repair stop or an
 * orchestration limit is surfaced verbatim; a fully valid report says nothing
 * (or notes limited steps); a safe-but-imperfect model report kept over the
 * fallback gets a calm caveat rather than a wall of raw validation issues;
 * only a report that isn't even safe still shows the raw issue list.
 */
function reportLastError(
  candidate: ReportCandidate,
  limitedSteps: boolean,
  repairStopReason: GenerationStopReason | undefined,
  steps: CriticalThinkingStepState[]
): string | null {
  if (repairStopReason) {
    return `Report repair stopped early. ${stoppedReasonMessage(repairStopReason)}`
  }
  if (candidate.overallValid) {
    return limitedSteps ? limitedResearchMessage(steps) : null
  }
  if (candidate.safe) {
    const base =
      'This report is drawn only from verified sources, but some passages did not meet every citation-coverage or section-structure check — read the flagged areas critically.'
    return limitedSteps ? `${base} ${limitedResearchMessage(steps)}` : base
  }
  return truncate(`Report validation remained incomplete: ${candidate.issues.join(' ')}`, 2_000)
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
