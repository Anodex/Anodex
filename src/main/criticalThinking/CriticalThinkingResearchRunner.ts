import type {
  CriticalThinkingActivity,
  CriticalThinkingRoundState,
  CriticalThinkingRun,
  CriticalThinkingStepState,
  CriticalThinkingTerminationReason
} from '@shared/criticalThinking.types'
import type { GenerationStats, GenerationStopReason } from '@shared/chat.types'
import type {
  ToolArtifact,
  WebFetchArtifactDraft,
  WebSearchArtifactDraft
} from '@shared/toolArtifacts.types'
import type { SearchResult } from '../tools/search/types'
import { createToolArtifact } from '../tools/types'
import type { RunGenerationResult } from '../chat/runGeneration'
import { CRITICAL_THINKING_STEP_BUDGET } from '../chat/GenerationBudget'
import {
  buildCriticalThinkingAssessmentPrompt,
  buildCriticalThinkingAssessmentRetryPrompt,
  buildCriticalThinkingQueryPrompt,
  buildCriticalThinkingQueryRetryPrompt
} from './criticalThinkingPrompts'
import { buildEvidencePacket } from './criticalThinkingEvidence'
import {
  boundPromptItems,
  criticalThinkingSynthesisLimits,
  evidencePacketChars,
  truncatePromptText
} from './criticalThinkingSynthesisBudget'
import {
  assessmentIsSufficient,
  mapWithConcurrency,
  selectResearchCandidates,
  type ResearchSearchBatch
} from './criticalThinkingResearchPolicy'
import { parseResearchAssessment, parseResearchQueries } from './criticalThinkingResearchOutput'
import {
  isRecoverableContentStopReason,
  runStructuredPhase
} from './criticalThinkingStructuredPhase'
import { isWeakCriticalThinkingSource } from './criticalThinkingSourceAuthority'
import { canonicalResearchUrl } from './criticalThinkingUrl'

/**
 * Per-phase hard output caps. A reasoning-tuned local model spends part of
 * every one of these on hidden thinking before the grammar-constrained JSON
 * begins (the engine reserves a guaranteed-visible majority — see
 * `defaultThoughtTokenBudget` — but the thinking still comes out of the same
 * cap), so each cap has to fit *thought plus answer*, not just the answer.
 *
 * Sized from a real 32K local run whose assessments were cut off mid-string:
 * a complete assessment object (finding, rationale, gaps, follow-up queries)
 * runs ~1,500-2,000 characters, roughly 500-600 tokens, which the previous
 * 1,024 cap could not fit alongside any reasoning at all.
 */
const QUERY_OUTPUT_TOKENS = 1_536
const ASSESSMENT_OUTPUT_TOKENS = 3_072
const MAX_ACTIVITY_LABEL_CHARS = 100
const MAX_ACTIVITY_DETAIL_CHARS = 180
const MAX_PRIOR_QUERY_CHARS = 2_400
const MAX_GAP_PROMPT_CHARS = 2_000
const MAX_PRIOR_FINDING_ITEMS = 12
const MAX_PRIOR_QUERY_ITEMS = 24
const MAX_GAP_ITEMS = 12
const MAX_EMPTY_ROUNDS = 2

export interface CriticalThinkingRunUsage {
  rounds: number
  searches: number
  fetches: number
}

export interface ResearchSearchResponse {
  provider: string
  results: SearchResult[]
}

export interface CriticalThinkingResearchRunnerDeps {
  getRun: () => CriticalThinkingRun
  listArtifacts: () => ToolArtifact[]
  runModel: (
    phase: 'query' | 'assessment',
    prompt: string,
    maxTokens: number,
    signal: AbortSignal
  ) => Promise<RunGenerationResult>
  search: (
    query: string,
    resultCount: number,
    signal: AbortSignal
  ) => Promise<ResearchSearchResponse>
  fetch: (url: string, focus: string, signal: AbortSignal) => Promise<WebFetchArtifactDraft>
  recordArtifact: (artifact: ToolArtifact, roundId: string) => void | Promise<void>
  updateStep: (patch: Partial<CriticalThinkingStepState>) => void
  appendRound: (round: CriticalThinkingRoundState) => void
  updateRound: (roundId: string, patch: Partial<CriticalThinkingRoundState>) => void
  recordActivity: (activity: CriticalThinkingActivity) => void
  addStats: (stats: GenerationStats) => void
  checkpoint: () => Promise<void>
  contextTokens: number
  /**
   * How many times each host has refused a fetch, shared across every step of
   * one run.
   *
   * Owned by the caller rather than the runner because a runner is constructed
   * per plan step. Holding this on the instance looked right and silently did
   * nothing: the map reset every step, so a seven-step run still spent fourteen
   * fetches per dead host. Measured — ssrn.com refused 13 times and
   * academic.oup.com 11 in exactly that state.
   */
  hostFailures: Map<string, number>
}

export interface CriticalThinkingResearchStepResult {
  status: CriticalThinkingStepState['status']
  stopped: boolean
  runBudgetReached: boolean
  /**
   * True when this call returned only because it reached `maxNewRoundsThisCall`
   * (a scheduler-imposed per-wave cap), not because the step's lifetime round
   * budget, a global run limit, or a real stop reason was hit. The step is
   * still `'researching'`-eligible and should be revisited in a later wave,
   * unlike a terminal `'limited'` status.
   */
  waveYielded?: boolean
}

export interface CriticalThinkingResearchRunnerOptions {
  /** Primarily injectable for deterministic timeout tests. */
  stepTimeoutMs?: number
}

/**
 * Executes one plan step as persisted, adaptive phases. Model calls are short
 * and tool-free; network search/fetch work is explicit, cancellable, and
 * concurrent. Every side-effecting phase is checkpointed before moving on.
 */
/**
 * Refusals from one host before the run stops spending fetch budget on it.
 * See `hostIsExhausted` for why this is two rather than one.
 */
const HOST_FAILURE_LIMIT = 2

export class CriticalThinkingResearchRunner {
  private readonly stepTimeoutMs: number

  constructor(
    private readonly deps: CriticalThinkingResearchRunnerDeps,
    options: CriticalThinkingResearchRunnerOptions = {}
  ) {
    this.stepTimeoutMs = positiveDuration(
      options.stepTimeoutMs,
      // Fixed background budget, never overridden to null — see GenerationBudget.ts.
      CRITICAL_THINKING_STEP_BUDGET.maxDurationMs ?? 10 * 60_000
    )
  }

  /**
   * `maxNewRoundsThisCall` bounds how many *new* rounds this single invocation
   * may start for the current step — separate from `policy.maxRoundsPerStep`,
   * which is the step's lifetime cap across every invocation. The scheduler
   * (`CriticalThinkingService.runResearchWaves`) calls this once per step per
   * wave with a cap of 1 so every approved step gets a first-pass round before
   * any step spends a second, instead of one step exhausting its full
   * lifetime allowance (and the run's global round/search/fetch budget) before
   * the next step is ever attempted. Omit it to let one call run a step to
   * completion or exhaustion, as before.
   */
  async run(
    signal: AbortSignal,
    usage: CriticalThinkingRunUsage,
    maxNewRoundsThisCall: number = Number.POSITIVE_INFINITY
  ): Promise<CriticalThinkingResearchStepResult> {
    const scope = createLinkedTimeout(signal, this.stepTimeoutMs)
    let emptyRounds = trailingEmptyRoundCount(
      currentStep(this.deps.getRun()),
      this.deps.listArtifacts()
    )
    let newRoundsThisCall = 0
    const abortReason = (): GenerationStopReason =>
      scope.timedOut() || scope.signal.reason === 'time-limit' ? 'time-limit' : 'user'
    try {
      while (!scope.signal.aborted) {
        const run = this.deps.getRun()
        const step = currentStep(run)
        const policy = run.researchPolicy
        const artifacts = this.deps.listArtifacts()
        const persistedAssessment = latestAcceptedAssessment(step, artifacts)
        if (persistedAssessment) {
          this.deps.updateStep({
            status: 'completed',
            finding: persistedAssessment.finding || step.finding,
            uncertainties: [],
            terminationReason: undefined
          })
          await this.deps.checkpoint()
          return { status: 'completed', stopped: false, runBudgetReached: false }
        }
        if (spentEvidenceCount(run, artifacts) >= policy.maxVerifiedSourcesPerRun) {
          return await this.limitStep('evidence-limit', true)
        }
        if (
          usage.searches >= policy.maxSearchesPerRun ||
          usage.fetches >= policy.maxFetchesPerRun
        ) {
          return await this.limitStep('tool-limit', true)
        }
        if (
          spentRoundCount(step) >= policy.maxRoundsPerStep ||
          usage.rounds >= policy.maxRoundsPerRun
        ) {
          if (stepHasReportableCoverage(step, artifacts, run.sources)) {
            return await this.completeStepAtResearchLimit(usage.rounds >= policy.maxRoundsPerRun)
          }
          return await this.limitStep('rounds-exhausted', usage.rounds >= policy.maxRoundsPerRun)
        }

        let round = resumableRound(step)
        if (!round) {
          if (newRoundsThisCall >= maxNewRoundsThisCall) {
            return {
              status: 'researching',
              stopped: false,
              runBudgetReached: false,
              waveYielded: true
            }
          }
          round = newRound(step)
          this.deps.appendRound(round)
          await this.deps.checkpoint()
          newRoundsThisCall++
        }
        if (round.status === 'querying') {
          const outcome = await this.ensureQueries(run, step, round, scope.signal, abortReason)
          if (outcome) return outcome
        }

        round = requireRound(this.deps.getRun(), round.id)
        if (round.status === 'searching' || round.status === 'querying') {
          const outcome = await this.searchRound(round, scope.signal, usage, abortReason)
          if (outcome) return outcome
        }

        round = requireRound(this.deps.getRun(), round.id)
        if (round.status === 'reading' || round.status === 'searching') {
          const fetched = await this.readRound(round, scope.signal, usage, abortReason)
          if (fetched.stopped) return fetched.result
          emptyRounds = fetched.verifiedPages > 0 ? 0 : emptyRounds + 1
        }

        if (scope.signal.aborted) break
        round = requireRound(this.deps.getRun(), round.id)
        const assessment = await this.assessRound(round, scope.signal, abortReason)
        if (assessment.stopped) return assessment.result

        usage.rounds++
        if (assessment.sufficient) {
          this.deps.updateStep({ status: 'completed', terminationReason: undefined })
          await this.deps.checkpoint()
          return { status: 'completed', stopped: false, runBudgetReached: false }
        }

        if (emptyRounds >= MAX_EMPTY_ROUNDS) {
          return await this.limitStep('no-progress', false)
        }
        const assessedStep = currentStep(this.deps.getRun())
        if (
          spentRoundCount(assessedStep) >= 2 &&
          stepHasReportableCoverage(
            assessedStep,
            this.deps.listArtifacts(),
            this.deps.getRun().sources
          )
        ) {
          return await this.completeStepAtResearchLimit(false)
        }
        if (
          spentRoundCount(assessedStep) >= policy.maxRoundsPerStep ||
          usage.rounds >= policy.maxRoundsPerRun ||
          usage.searches >= policy.maxSearchesPerRun ||
          usage.fetches >= policy.maxFetchesPerRun
        ) {
          const runBudgetReached =
            usage.rounds >= policy.maxRoundsPerRun ||
            usage.searches >= policy.maxSearchesPerRun ||
            usage.fetches >= policy.maxFetchesPerRun
          const reason: GenerationStopReason =
            usage.searches >= policy.maxSearchesPerRun || usage.fetches >= policy.maxFetchesPerRun
              ? 'tool-limit'
              : 'rounds-exhausted'
          return await this.limitStep(reason, runBudgetReached)
        }
      }

      return await this.stopStep(abortReason())
    } finally {
      scope.dispose()
    }
  }

  private async ensureQueries(
    run: CriticalThinkingRun,
    step: CriticalThinkingStepState,
    round: CriticalThinkingRoundState,
    signal: AbortSignal,
    abortReason: () => GenerationStopReason
  ): Promise<CriticalThinkingResearchStepResult | null> {
    if (round.queries.length > 0) {
      this.deps.updateRound(round.id, { status: 'searching', terminationReason: undefined })
      await this.deps.checkpoint()
      return null
    }
    const policy = run.researchPolicy
    const priorAssessment = [...step.rounds]
      .reverse()
      .find((candidate) => candidate.id !== round.id && candidate.assessment)?.assessment
    const proposed = priorAssessment?.nextQueries ?? []
    const initiallyNovel = novelQueries(proposed, usedQueries(step), policy.maxQueriesPerRound)
    const gapQueries =
      proposed.length >= policy.maxQueriesPerRound &&
      initiallyNovel.length < policy.maxQueriesPerRound
        ? buildGapResearchQueries(
            priorAssessment?.remainingGaps ?? [],
            step.title,
            policy.maxQueriesPerRound - initiallyNovel.length
          )
        : []
    const novelProposed = novelQueries(
      [...initiallyNovel, ...gapQueries],
      usedQueries(step),
      policy.maxQueriesPerRound
    )
    if (novelProposed.length > 0) {
      this.deps.updateRound(round.id, {
        queries: novelProposed,
        status: 'searching',
        terminationReason: undefined
      })
      await this.deps.checkpoint()
      return null
    }

    const activity = this.startActivity('analysis', `Choose searches for round ${round.index + 1}`)
    const limits = criticalThinkingSynthesisLimits(this.deps.contextTokens)
    const priorFindings = run.steps
      .filter((candidate) => candidate.id !== step.id)
      .map((candidate) => candidate.finding)
      .slice(0, MAX_PRIOR_FINDING_ITEMS)
    const priorQueries = usedQueries(step).slice(-MAX_PRIOR_QUERY_ITEMS)
    const gaps = (priorAssessment?.remainingGaps ?? []).slice(0, MAX_GAP_ITEMS)
    const fallback = buildFallbackResearchQuery(run.question, step.title, round.index, gaps)
    try {
      const prompt = buildBudgetedQueryPrompt(
        truncatePromptText(run.question, limits.maxQuestionChars),
        truncatePromptText(step.title, 600),
        priorFindings,
        priorQueries,
        gaps,
        round.index + 1,
        policy.maxQueriesPerRound,
        limits.maxPromptChars,
        limits.maxFindingChars
      )
      const phase = await runStructuredPhase(prompt, signal, {
        generate: (isolatedPrompt) =>
          this.deps.runModel('query', isolatedPrompt, QUERY_OUTPUT_TOKENS, signal),
        parse: (content) => {
          const parsed = parseResearchQueries(content, fallback, policy.maxQueriesPerRound)
          return {
            value: parsed.valid && parsed.queries.length > 0 ? parsed.queries : null,
            valid: parsed.valid,
            issues: parsed.valid ? [] : ['The response was not the required query JSON.']
          }
        },
        buildRepairPrompt: () =>
          buildCriticalThinkingQueryRetryPrompt(
            truncatePromptText(run.question, limits.maxQuestionChars),
            truncatePromptText(step.title, 600),
            policy.maxQueriesPerRound
          )
      })
      this.deps.addStats(phase.stats)
      let selectedQueries = phase.value
      if (!selectedQueries) {
        // A genuine user Stop, or an orchestration-level limit (time/tool/
        // round budget, loop guard) that never even reached parsing — pause
        // the round with that reason rather than guessing at a query.
        if (phase.stopReason && !isRecoverableContentStopReason(phase.stopReason)) {
          const reason = phase.stopReason
          this.finishActivity(activity, 'error', stoppedDetail(reason))
          return await this.stopStep(reason, round.id)
        }
        selectedQueries = parseResearchQueries('', fallback, policy.maxQueriesPerRound).queries
      }
      const queries = novelQueries(selectedQueries, usedQueries(step), policy.maxQueriesPerRound)
      if (queries.length === 0) {
        this.finishActivity(activity, 'error', 'No novel query was available')
        return await this.limitStep('no-progress', false, round.id)
      }
      this.deps.updateRound(round.id, {
        queries,
        status: 'searching',
        terminationReason: undefined
      })
      this.finishActivity(
        activity,
        'success',
        phase.valid ? `${queries.length} focused queries` : 'Used a bounded fallback query'
      )
      await this.deps.checkpoint()
      return null
    } catch (error) {
      if (signal.aborted) {
        const reason = abortReason()
        this.finishActivity(activity, 'error', stoppedDetail(reason))
        return await this.stopStep(reason, round.id)
      }
      this.finishActivity(activity, 'error', errorMessage(error))
      throw error
    }
  }

  private async searchRound(
    round: CriticalThinkingRoundState,
    signal: AbortSignal,
    usage: CriticalThinkingRunUsage,
    abortReason: () => GenerationStopReason
  ): Promise<CriticalThinkingResearchStepResult | null> {
    const run = this.deps.getRun()
    const policy = run.researchPolicy
    const artifacts = artifactsForRound(this.deps.listArtifacts(), round.id)
    const searched = new Set(
      artifacts
        .filter((artifact) => artifact.kind === 'web-search')
        .map((artifact) => artifact.query.toLowerCase())
    )
    const remainingBudget = Math.max(0, policy.maxSearchesPerRun - usage.searches)
    const pending = round.queries
      .filter((query) => !searched.has(query.toLowerCase()))
      .slice(0, remainingBudget)
    if (pending.length === 0 && round.queries.some((query) => !searched.has(query.toLowerCase()))) {
      return this.pauseStep('tool-limit', true, round.id)
    }

    this.deps.updateRound(round.id, { status: 'searching', terminationReason: undefined })
    await this.deps.checkpoint()
    const results = await mapWithConcurrency(
      pending,
      policy.searchConcurrency,
      async (query) => {
        // Count attempts only when a worker actually starts them. A timeout can
        // stop the queue before every reserved item begins; charging those
        // unstarted items would incorrectly consume the next step's budget.
        usage.searches++
        const activity = this.startActivity('search', `Search “${truncate(query, 72)}”`)
        try {
          const response = await this.deps.search(query, policy.maxResultsPerQuery, signal)
          const draft: WebSearchArtifactDraft = {
            kind: 'web-search',
            query,
            provider: response.provider,
            results: response.results.map((result, index) => ({ ...result, rank: index + 1 })),
            research: researchIdentity(this.deps.getRun(), round.id)
          }
          const artifact = createToolArtifact(artifactIdentity(run.id), draft)
          await this.deps.recordArtifact(artifact, round.id)
          this.finishActivity(activity, 'success', `${response.results.length} results`)
          return artifact
        } catch (error) {
          this.finishActivity(activity, 'error', errorMessage(error))
          throw error
        }
      },
      signal
    )
    if (signal.aborted) return this.stopStep(abortReason(), round.id)
    // Every search this round failed (provider rejected each query). Limit
    // this step and let the run continue to other steps and synthesize
    // whatever evidence exists — throwing here would unwind the whole
    // investigation into a reportless failure (see `everyOperationFailed`).
    if (everyOperationFailed(results)) {
      return this.limitStep('no-progress', false, round.id)
    }

    const searchedAfterAttempt = new Set(
      artifactsForRound(this.deps.listArtifacts(), round.id)
        .filter((artifact) => artifact.kind === 'web-search')
        .map((artifact) => artifact.query.toLowerCase())
    )
    if (
      usage.searches >= policy.maxSearchesPerRun &&
      round.queries.some((query) => !searchedAfterAttempt.has(query.toLowerCase()))
    ) {
      return this.pauseStep('tool-limit', true, round.id)
    }

    const persistedArtifacts = this.deps.listArtifacts()
    const allArtifacts = artifactsForRound(persistedArtifacts, round.id)
    const batches = allArtifacts.flatMap<ResearchSearchBatch>((artifact) =>
      artifact.kind === 'web-search'
        ? [
            {
              query: artifact.query,
              results: artifact.results.map(({ title, url, snippet }) => ({ title, url, snippet }))
            }
          ]
        : []
    )
    this.attachReusableEvidence(round.id, batches, persistedArtifacts)
    const selectedUrls =
      round.selectedUrls.length > 0
        ? round.selectedUrls
        : selectResearchCandidates(
            batches,
            fetchedUrls(persistedArtifacts),
            policy.maxPagesPerRound
          ).map((candidate) => candidate.url)
    this.deps.updateRound(round.id, {
      selectedUrls,
      status: 'reading',
      terminationReason: undefined
    })
    await this.deps.checkpoint()
    return null
  }

  /** Record that a host refused a fetch, so the run stops paying for it. */
  private noteHostFailure(url: string): void {
    const host = safeHostname(url)
    this.deps.hostFailures.set(host, (this.deps.hostFailures.get(host) ?? 0) + 1)
  }

  /**
   * Whether this host has refused often enough to stop trying.
   *
   * Two, not one: a single failure is as likely to be a timeout or a transient
   * 503 as a paywall, and condemning a good host on one blip would cost more
   * evidence than it saves. Two consecutive refusals from the same host is a
   * pattern, and the remaining budget is better spent on a host that answers.
   */
  private hostIsExhausted(url: string): boolean {
    return (this.deps.hostFailures.get(safeHostname(url)) ?? 0) >= HOST_FAILURE_LIMIT
  }

  private async readRound(
    round: CriticalThinkingRoundState,
    signal: AbortSignal,
    usage: CriticalThinkingRunUsage,
    abortReason: () => GenerationStopReason
  ): Promise<{
    verifiedPages: number
    stopped: boolean
    result: CriticalThinkingResearchStepResult
  }> {
    const run = this.deps.getRun()
    const step = currentStep(run)
    const policy = run.researchPolicy
    const attemptedHere = new Set<string>()
    const settled: PromiseSettledResult<ToolArtifact>[] = []
    this.deps.updateRound(round.id, { status: 'reading', terminationReason: undefined })
    await this.deps.checkpoint()

    while (!signal.aborted) {
      const persistedArtifacts = this.deps.listArtifacts()
      const fetchedInRound = fetchedUrls(artifactsForRound(persistedArtifacts, round.id))
      const unattempted = round.selectedUrls.filter((url) => {
        const canonical = canonicalResearchUrl(url)
        if (fetchedInRound.has(canonical) || attemptedHere.has(canonical)) return false
        // Filtered here rather than after the budget slice: a URL removed later
        // would never be marked attempted, so it would stay in this list and the
        // loop would never drain it.
        return !this.hostIsExhausted(url)
      })
      if (unattempted.length === 0) break

      const remainingBudget = Math.max(0, policy.maxFetchesPerRun - usage.fetches)
      const remainingEvidenceCapacity = Math.max(
        0,
        policy.maxVerifiedSourcesPerRun - spentEvidenceCount(run, persistedArtifacts)
      )
      if (remainingEvidenceCapacity === 0) {
        return {
          verifiedPages: 0,
          stopped: true,
          result: await this.pauseStep('evidence-limit', true, round.id)
        }
      }
      if (remainingBudget === 0) {
        return {
          verifiedPages: 0,
          stopped: true,
          result: await this.pauseStep('tool-limit', true, round.id)
        }
      }

      // Never launch more potentially verified pages than the lifetime source
      // index can still retain. If a page is unreadable or fails, the next loop
      // fills the unused capacity from a later selected URL.
      const pending = unattempted.slice(0, Math.min(remainingBudget, remainingEvidenceCapacity))
      const results = await mapWithConcurrency(
        pending,
        policy.fetchConcurrency,
        async (url) => {
          // See the matching search counter above: only work that started counts
          // against the active attempt's fetch budget.
          attemptedHere.add(canonicalResearchUrl(url))
          // Checked here, not before the batch: the slice is taken before any
          // fetch runs, so a host that refuses its first URL would otherwise
          // still consume the whole batch. Inside the operation, failures from
          // earlier items are already recorded.
          //
          // Costs no fetch budget and records no activity: nothing was tried.
          if (this.hostIsExhausted(url)) return null
          usage.fetches++
          const activity = this.startActivity('reading', `Read ${safeHostname(url)}`)
          try {
            const draft = await this.deps.fetch(url, `${run.question}\n${step.title}`, signal)
            const artifact = createToolArtifact(artifactIdentity(run.id), {
              ...draft,
              research: researchIdentity(run, round.id)
            })
            await this.deps.recordArtifact(artifact, round.id)
            this.finishActivity(activity, 'success', `${draft.passages.length} focused passages`)
            return artifact
          } catch (error) {
            this.noteHostFailure(url)
            this.finishActivity(activity, 'error', errorMessage(error))
            throw error
          }
        },
        signal
      )
      settled.push(
        ...results.filter(
          (result): result is PromiseSettledResult<ToolArtifact> =>
            !(result.status === 'fulfilled' && result.value === null)
        )
      )
      await this.deps.checkpoint()
    }

    if (signal.aborted) {
      return {
        verifiedPages: 0,
        stopped: true,
        result: await this.stopStep(abortReason(), round.id)
      }
    }
    // Every selected page this round failed to load (e.g. a burst of 403s).
    // Limit this step and move on — earlier steps' verified evidence and the
    // final report must survive one dead round, so this must not throw.
    if (everyOperationFailed(settled)) {
      return {
        verifiedPages: 0,
        stopped: true,
        result: await this.limitStep('no-progress', false, round.id)
      }
    }
    const currentRound = requireRound(this.deps.getRun(), round.id)
    const verifiedPages = verifiedUrlsForRound(this.deps.listArtifacts(), currentRound).size
    this.deps.updateRound(round.id, { status: 'assessing', terminationReason: undefined })
    await this.deps.checkpoint()
    return {
      verifiedPages,
      stopped: false,
      result: { status: 'researching', stopped: false, runBudgetReached: false }
    }
  }

  private async assessRound(
    round: CriticalThinkingRoundState,
    signal: AbortSignal,
    abortReason: () => GenerationStopReason
  ): Promise<{
    sufficient: boolean
    stopped: boolean
    result: CriticalThinkingResearchStepResult
  }> {
    const run = this.deps.getRun()
    const step = currentStep(run)
    // The assessment prompt's fixed text is not an input, and sizing the
    // shares without it charges its cost to the evidence packet this check
    // reads. A starved coverage check cannot see that a step is already
    // answered, so it asks for more searches -- the same run then gathers
    // more sources and hands each one a thinner slice. Account for the
    // scaffold so the evidence share is the share actually delivered.
    const assessmentScaffoldChars = buildCriticalThinkingAssessmentPrompt(
      '',
      '',
      [],
      '',
      round.index + 1,
      run.researchPolicy.maxQueriesPerRound
    ).length
    const limits = criticalThinkingSynthesisLimits(
      this.deps.contextTokens,
      undefined,
      assessmentScaffoldChars
    )
    const artifacts = this.deps.listArtifacts()
    const stepArtifactSet = new Set(step.evidenceIds)
    const stepArtifacts = artifacts.filter((artifact) => stepArtifactSet.has(artifact.id))
    const priorFindings = boundPromptItems(
      run.steps
        .filter((candidate) => candidate.id !== step.id)
        .map((candidate) => candidate.finding),
      limits.maxFindingChars
    )
    const question = truncatePromptText(run.question, limits.maxQuestionChars)
    const stepTitle = truncatePromptText(step.title, 600)
    const promptBase = buildCriticalThinkingAssessmentPrompt(
      question,
      stepTitle,
      priorFindings,
      '',
      round.index + 1,
      run.researchPolicy.maxQueriesPerRound
    )
    const evidencePacket = buildEvidencePacket(
      stepArtifacts,
      run.sources,
      evidencePacketChars(limits, promptBase.length)
    )
    const activity = this.startActivity('analysis', 'Check evidence coverage')
    try {
      const phase = await runStructuredPhase(
        buildCriticalThinkingAssessmentPrompt(
          question,
          stepTitle,
          priorFindings,
          evidencePacket,
          round.index + 1,
          run.researchPolicy.maxQueriesPerRound
        ),
        signal,
        {
          generate: (prompt) =>
            this.deps.runModel('assessment', prompt, ASSESSMENT_OUTPUT_TOKENS, signal),
          parse: (content) => {
            const parsed = parseResearchAssessment(content, run.researchPolicy.maxQueriesPerRound)
            return {
              value: parsed.valid ? parsed : null,
              valid: parsed.valid,
              issues: parsed.valid ? [] : ['The response was not the required assessment JSON.']
            }
          },
          buildRepairPrompt: () =>
            buildCriticalThinkingAssessmentRetryPrompt(
              question,
              stepTitle,
              evidencePacket,
              run.researchPolicy.maxQueriesPerRound
            )
        }
      )
      this.deps.addStats(phase.stats)
      if (!phase.value && phase.stopReason && !isRecoverableContentStopReason(phase.stopReason)) {
        // A genuine user Stop, or an orchestration-level limit (time/tool/
        // round budget, loop guard, no progress) that never even reached
        // parsing — pause the round with that reason.
        const reason = phase.stopReason
        this.finishActivity(activity, 'error', stoppedDetail(reason))
        return {
          sufficient: false,
          stopped: true,
          result: await this.stopStep(reason, round.id)
        }
      }
      const parsed =
        phase.value ?? parseResearchAssessment(phase.content, run.researchPolicy.maxQueriesPerRound)
      const verifiedUrlCount = verifiedUrlsForStep(stepArtifacts, step).size
      const sufficient = Boolean(
        parsed.assessment && assessmentIsSufficient(parsed.assessment, verifiedUrlCount)
      )
      const assessment = parsed.assessment ?? {
        verdict: 'continue' as const,
        evidenceBasis: 'insufficient' as const,
        rationale: 'The model response could not be validated as a structured coverage decision.',
        // Left empty rather than an internal diagnostic sentence — a step's
        // gap list is user-facing (rendered verbatim in the report and in
        // "Why some areas are incomplete"), and "A valid evidence coverage
        // assessment is still required" reads as a research gap when it is
        // actually a parser-failure message about our own JSON contract.
        // Leaving this empty lets the fallback below use `parsed.uncertainties`
        // instead — whatever the model's own raw text actually said was
        // missing, which is meaningful to a reader; this placeholder was not.
        remainingGaps: [],
        nextQueries: []
      }
      // Only fall back to the step's prior finding when it already holds one:
      // clobbering a validated multi-round finding with an unvalidated round's
      // text would let one malformed response erase earlier, real progress
      // (see the "does not replace a valid cumulative finding" test). But when
      // the step has no finding yet, keeping `step.finding` empty just to be
      // "safe" throws away the model's actual work for no benefit — this round
      // was going to be the step's only content either way, and
      // `parseResearchAssessment` already extracts `finding` (or the raw
      // response text as a last resort) independent of whether the
      // verdict/evidenceBasis JSON scaffolding parsed, so there is real
      // substance here even when `valid` is false.
      const finding = parsed.valid || !step.finding.trim() ? parsed.finding : step.finding
      this.deps.updateRound(round.id, {
        status: 'completed',
        finding,
        assessment,
        terminationReason: undefined,
        completedAt: Date.now()
      })
      this.deps.updateStep({
        finding,
        uncertainties:
          assessment.remainingGaps.length > 0 ? assessment.remainingGaps : parsed.uncertainties,
        terminationReason: undefined
      })
      this.finishActivity(
        activity,
        parsed.valid ? 'success' : 'error',
        parsed.valid
          ? sufficient
            ? 'Coverage sufficient'
            : `${assessment.remainingGaps.length} gaps remain`
          : 'Invalid structured assessment; another bounded round is required'
      )
      await this.deps.checkpoint()
      return {
        sufficient,
        stopped: false,
        result: { status: 'researching', stopped: false, runBudgetReached: false }
      }
    } catch (error) {
      if (signal.aborted) {
        const reason = abortReason()
        this.finishActivity(activity, 'error', stoppedDetail(reason))
        return {
          sufficient: false,
          stopped: true,
          result: await this.stopStep(reason, round.id)
        }
      }
      this.finishActivity(activity, 'error', errorMessage(error))
      throw error
    }
  }

  private attachReusableEvidence(
    roundId: string,
    batches: ResearchSearchBatch[],
    artifacts: ToolArtifact[]
  ): void {
    const surfacedUrls = new Set(
      batches.flatMap((batch) => batch.results.map((result) => canonicalResearchUrl(result.url)))
    )
    const reusableIds = artifacts.flatMap((artifact) => {
      if (artifact.kind !== 'web-fetch' || artifact.passages.length === 0) return []
      const artifactUrls = canonicalFetchUrls(artifact)
      return artifactUrls.some((url) => surfacedUrls.has(url)) ? [artifact.id] : []
    })
    if (reusableIds.length === 0) return

    const run = this.deps.getRun()
    const step = currentStep(run)
    const round = requireRound(run, roundId)
    this.deps.updateStep({ evidenceIds: uniqueStrings([...step.evidenceIds, ...reusableIds]) })
    this.deps.updateRound(roundId, {
      evidenceIds: uniqueStrings([...round.evidenceIds, ...reusableIds])
    })
  }

  private async limitStep(
    reason: CriticalThinkingTerminationReason,
    runBudgetReached: boolean,
    roundId?: string
  ): Promise<CriticalThinkingResearchStepResult> {
    if (roundId) {
      this.deps.updateRound(roundId, {
        status: 'limited',
        terminationReason: reason,
        completedAt: Date.now()
      })
    }
    this.deps.updateStep({ status: 'limited', terminationReason: reason })
    await this.deps.checkpoint()
    return { status: 'limited', stopped: false, runBudgetReached }
  }

  private async completeStepAtResearchLimit(
    runBudgetReached: boolean
  ): Promise<CriticalThinkingResearchStepResult> {
    // The research floor is service-owned: after multiple productive rounds,
    // strong, diverse evidence can support a report even when the local model
    // keeps proposing optional literature gaps. Preserve those gaps for the
    // report's limits section instead of mislabeling the whole step limited.
    this.deps.updateStep({ status: 'completed', terminationReason: undefined })
    await this.deps.checkpoint()
    return { status: 'completed', stopped: false, runBudgetReached }
  }

  private async stopStep(
    reason: GenerationStopReason,
    roundId?: string
  ): Promise<CriticalThinkingResearchStepResult> {
    return this.pauseStep(reason, false, roundId)
  }

  private async pauseStep(
    reason: CriticalThinkingTerminationReason,
    runBudgetReached: boolean,
    roundId?: string
  ): Promise<CriticalThinkingResearchStepResult> {
    const userStopped = reason === 'user'
    if (roundId) {
      this.deps.updateRound(roundId, {
        terminationReason: reason,
        completedAt: null
      })
    }
    this.deps.updateStep({
      status: userStopped ? 'pending' : 'limited',
      terminationReason: reason
    })
    await this.deps.checkpoint()
    return {
      status: userStopped ? 'pending' : 'limited',
      stopped: userStopped,
      runBudgetReached
    }
  }

  private startActivity(
    kind: CriticalThinkingActivity['kind'],
    label: string
  ): CriticalThinkingActivity {
    const activity: CriticalThinkingActivity = {
      id: `critical_activity_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      kind,
      label: truncate(label, MAX_ACTIVITY_LABEL_CHARS),
      status: 'running',
      createdAt: Date.now()
    }
    this.deps.recordActivity(activity)
    return activity
  }

  private finishActivity(
    activity: CriticalThinkingActivity,
    status: CriticalThinkingActivity['status'],
    detail: string
  ): void {
    this.deps.recordActivity({
      ...activity,
      status,
      detail: truncate(detail, MAX_ACTIVITY_DETAIL_CHARS)
    })
  }
}

function buildBudgetedQueryPrompt(
  questionCandidate: string,
  stepCandidate: string,
  priorFindingCandidates: string[],
  priorQueryCandidates: string[],
  gapCandidates: string[],
  roundNumber: number,
  maxQueries: number,
  maxPromptChars: number,
  maxFindingChars: number
): string {
  const skeleton = buildCriticalThinkingQueryPrompt('', '', [], [], [], roundNumber, maxQueries)
  const identityBudget = Math.max(0, maxPromptChars - skeleton.length)
  const [questionBudget, stepBudget] = allocateCharBudgets(
    [questionCandidate.length, stepCandidate.length],
    identityBudget
  )
  const question = truncatePromptText(questionCandidate, questionBudget)
  const step = truncatePromptText(stepCandidate, stepBudget)
  const base = buildCriticalThinkingQueryPrompt(question, step, [], [], [], roundNumber, maxQueries)
  const candidates = [priorFindingCandidates, priorQueryCandidates, gapCandidates]
  const itemOverhead = Math.min(
    Math.max(0, maxPromptChars - base.length),
    candidates.reduce((total, items) => total + items.filter((item) => item.trim()).length * 4, 32)
  )
  const contentBudget = Math.max(0, maxPromptChars - base.length - itemOverhead)
  const budgets = allocateCharBudgets(
    [
      Math.min(maxFindingChars, totalItemChars(priorFindingCandidates)),
      Math.min(MAX_PRIOR_QUERY_CHARS, totalItemChars(priorQueryCandidates)),
      Math.min(MAX_GAP_PROMPT_CHARS, totalItemChars(gapCandidates))
    ],
    contentBudget
  )
  let findings = boundPromptItems(priorFindingCandidates, budgets[0])
  let queries = boundPromptItems(priorQueryCandidates, budgets[1])
  let gaps = boundPromptItems(gapCandidates, budgets[2])
  const render = (): string =>
    buildCriticalThinkingQueryPrompt(
      question,
      step,
      findings,
      queries,
      gaps,
      roundNumber,
      maxQueries
    )
  let prompt = render()

  // The estimate above reserves bullet/newline framing. Keep an exact final
  // guard so even pathological tiny items cannot overrun the real char cap.
  for (const group of ['findings', 'queries', 'gaps'] as const) {
    if (prompt.length <= maxPromptChars) break
    const overflow = prompt.length - maxPromptChars
    if (group === 'findings') {
      findings = boundPromptItems(findings, Math.max(0, totalItemChars(findings) - overflow - 8))
    } else if (group === 'queries') {
      queries = boundPromptItems(queries, Math.max(0, totalItemChars(queries) - overflow - 8))
    } else {
      gaps = boundPromptItems(gaps, Math.max(0, totalItemChars(gaps) - overflow - 8))
    }
    prompt = render()
  }
  return prompt.length <= maxPromptChars ? prompt : base
}

function allocateCharBudgets(capacities: number[], totalBudget: number): number[] {
  const safeCapacities = capacities.map((capacity) =>
    Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0
  )
  const budgets = safeCapacities.map(() => 0)
  let remaining = Number.isFinite(totalBudget) ? Math.max(0, Math.floor(totalBudget)) : 0
  while (remaining > 0) {
    const active = safeCapacities
      .map((capacity, index) => ({ capacity, index }))
      .filter(({ capacity, index }) => budgets[index] < capacity)
    if (active.length === 0) break
    const share = Math.max(1, Math.floor(remaining / active.length))
    let allocated = 0
    for (const { capacity, index } of active) {
      if (remaining <= 0) break
      const amount = Math.min(share, capacity - budgets[index], remaining)
      budgets[index] += amount
      remaining -= amount
      allocated += amount
    }
    if (allocated === 0) break
  }
  return budgets
}

function totalItemChars(items: string[]): number {
  return items.reduce((total, item) => total + item.trim().length, 0)
}

function newRound(step: CriticalThinkingStepState): CriticalThinkingRoundState {
  return {
    id: `round_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    index: step.rounds.length,
    status: 'querying',
    queries: [],
    selectedUrls: [],
    evidenceIds: [],
    finding: '',
    assessment: null,
    startedAt: Date.now(),
    completedAt: null
  }
}

function resumableRound(step: CriticalThinkingStepState): CriticalThinkingRoundState | null {
  const latest = step.rounds.at(-1)
  return latest && ['querying', 'searching', 'reading', 'assessing'].includes(latest.status)
    ? latest
    : null
}

/**
 * Rounds this step has actually spent against its lifetime `maxRoundsPerStep`
 * cap, derived from persisted state rather than a per-invocation counter —
 * required so the cap is enforced correctly across the multiple separate
 * `run()` calls a wave-based scheduler makes for the same step. A round still
 * in progress (resumable) hasn't been spent yet; it either completes or gets
 * limited on a later call.
 */
function spentRoundCount(step: CriticalThinkingStepState): number {
  const spent = resumableRound(step) ? step.rounds.length - 1 : step.rounds.length
  // Counted from where the last resume rebased it, so an explicit resume buys
  // a fresh allowance rather than restarting an already-exhausted step.
  return Math.max(0, spent - (step.roundBudgetBase ?? 0))
}

function trailingEmptyRoundCount(
  step: CriticalThinkingStepState,
  artifacts: ToolArtifact[]
): number {
  let count = 0
  for (let index = step.rounds.length - 1; index >= 0; index--) {
    const round = step.rounds[index]
    if (round.status !== 'completed') break
    const evidenceIds = new Set(round.evidenceIds)
    const hasVerifiedPage = artifacts.some(
      (artifact) =>
        artifact.kind === 'web-fetch' &&
        artifact.passages.length > 0 &&
        (artifact.research?.roundId === round.id || evidenceIds.has(artifact.id))
    )
    if (hasVerifiedPage) break
    count++
  }
  return count
}

/**
 * Verified sources gathered against the run's *current* evidence allowance.
 *
 * The ceiling is a lifetime one, counted from everything the run has ever
 * verified, so an investigation that reached it stopped the instant a resume
 * restarted it -- the same dead end the per-step round cap had, one limiter
 * along. Observed live: a resumed run ended a step with `evidence-limit`
 * after eight rounds, having filled its allowance on earlier attempts.
 *
 * A resume rebases the count, so the user gets the allowance they just asked
 * for while everything already gathered stays available to cite.
 */
function spentEvidenceCount(run: CriticalThinkingRun, artifacts: ToolArtifact[]): number {
  return Math.max(0, verifiedUrlCount(artifacts) - (run.evidenceBudgetBase ?? 0))
}

function currentStep(run: CriticalThinkingRun): CriticalThinkingStepState {
  const step = run.steps[run.currentStep]
  if (!step) throw new Error('Critical Thinking research step not found.')
  return step
}

function requireRound(run: CriticalThinkingRun, roundId: string): CriticalThinkingRoundState {
  const round = currentStep(run).rounds.find((candidate) => candidate.id === roundId)
  if (!round) throw new Error('Critical Thinking research round not found.')
  return round
}

function usedQueries(step: CriticalThinkingStepState): string[] {
  return step.rounds.flatMap((round) => round.queries)
}

const FALLBACK_QUERY_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'from',
  'with',
  'that',
  'this',
  'into',
  'across',
  'current',
  'strongest',
  'evidence',
  'search',
  'examine',
  'review',
  'consult',
  'compare',
  'comparative',
  'related',
  'why',
  'differ',
  // Imperative verbs that open a plan step's title. They describe what the
  // investigation should do, never what the page being searched for contains,
  // so they only dilute the terms that actually scope the query.
  'identify',
  'investigate',
  'research',
  'survey',
  'map',
  'analyze',
  'analyse',
  'assess',
  'determine',
  'evaluate',
  'explore',
  'gather',
  'outline',
  // Function words long enough to survive the 3-character term filter. They
  // occupy slots in a bounded query without narrowing it at all.
  'especially',
  'their',
  'there',
  'could',
  'would',
  'should',
  'other',
  'also',
  'than',
  'when',
  'where',
  'which',
  'while',
  'what',
  'have',
  'been',
  'they',
  'them'
])

/**
 * A search engine given 28 keywords matches the dominant generic nouns and
 * ignores the rest. Observed directly: a step scoped to "…projects in Colorado
 * (especially Commerce City/Denver metro) that utilize excavators and wheel
 * loaders" fell back to a 28-term query and returned a Chinese excavator
 * manufacturer, a UAE dealer, and Hitachi Construction Machinery *Africa* —
 * every result matched "excavators", "wheel", "loaders", "construction" and
 * none matched Colorado. A real query is short.
 */
const FALLBACK_QUERY_MAX_TERMS = 12

/**
 * A compact keyword query when a local model cannot satisfy the JSON query
 * contract.
 *
 * Varies by round. This used to be a pure function of question + step title,
 * so every later round rebuilt the identical string, `novelQueries` rejected
 * it as already used, and the step died on `no-progress` after a single
 * search. A step whose query phase keeps failing got exactly one attempt with
 * one mediocre query — observed live, and the reason a Colorado-scoped step
 * kept nothing but the four off-target pages its first search returned.
 *
 * Round 2+ leads with the gaps the previous round's assessment recorded (the
 * specific thing still missing), and falls back to advancing a window over the
 * step's own terms so the query is at least different from the one that
 * already failed.
 */
function buildFallbackResearchQuery(
  question: string,
  step: string,
  roundIndex = 0,
  gaps: string[] = []
): string {
  // The step title is the research target and already carries the question's
  // scope (the planner wrote it from the question), so it leads. Question
  // terms only top up a title too terse to search on by itself.
  const stepTerms = relevantQueryTerms(step)
  const topUp = relevantQueryTerms(question)
  // Bounded so the step's own scope always survives alongside the gap.
  const gapTerms = roundIndex > 0 ? relevantQueryTerms(gaps.join(' ')).slice(0, 6) : []
  // Rotated every round, including when a gap leads: a step can record the
  // same gap twice, and two rounds that build the same string leave the second
  // with no novel query at all.
  const rotation = stepTerms.length > 0 ? (roundIndex * 3) % stepTerms.length : 0
  const rotated = [...stepTerms.slice(rotation), ...stepTerms.slice(0, rotation)]
  const seen = new Set<string>()
  const terms = [...gapTerms, ...rotated, ...topUp]
    .filter((term) => {
      if (seen.has(term)) return false
      seen.add(term)
      return true
    })
    .slice(0, FALLBACK_QUERY_MAX_TERMS)
  const query = terms.join(' ').trim()
  return query ? truncate(query, 300) : truncate(step, 300)
}

function buildGapResearchQueries(gaps: string[], stepTitle: string, limit: number): string[] {
  const stepTerms = relevantQueryTerms(stepTitle).slice(0, 5).join(' ')
  return gaps.slice(0, Math.max(0, limit)).flatMap((gap) => {
    const cleaned = gap
      .replace(/^(?:no|lack of|missing|insufficient|limited|unavailable|not retrieved)\s+/i, '')
      .replace(/\b(?:is|are|was|were)?\s*(?:absent|missing) from (?:the )?evidence\b/gi, '')
      .replace(/\s+/g, ' ')
      .replace(/[.;:,]+$/g, '')
      .trim()
    if (!cleaned) return []
    return [truncate(`${cleaned} ${stepTerms} peer reviewed primary study`, 300)]
  })
}

function relevantQueryTerms(value: string): string[] {
  const seen = new Set<string>()
  return (
    value
      .toLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu)
      ?.filter((term) => {
        if (FALLBACK_QUERY_STOP_WORDS.has(term) || seen.has(term)) return false
        seen.add(term)
        return true
      }) ?? []
  )
}

function novelQueries(queries: string[], used: string[], limit: number): string[] {
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  if (boundedLimit === 0) return []
  const seen = new Set(used.map((query) => query.trim().toLowerCase()))
  return queries
    .flatMap((query) => {
      const normalized = query.replace(/\s+/g, ' ').trim()
      const key = normalized.toLowerCase()
      if (!key || seen.has(key)) return []
      seen.add(key)
      return [normalized]
    })
    .slice(0, boundedLimit)
}

function artifactsForRound(artifacts: ToolArtifact[], roundId: string): ToolArtifact[] {
  return artifacts.filter((artifact) => artifact.research?.roundId === roundId)
}

function fetchedUrls(artifacts: ToolArtifact[]): Set<string> {
  return new Set(
    artifacts.flatMap((artifact) =>
      artifact.kind === 'web-fetch' ? canonicalFetchUrls(artifact) : []
    )
  )
}

function canonicalFetchUrls(artifact: Extract<ToolArtifact, { kind: 'web-fetch' }>): string[] {
  return uniqueStrings([
    canonicalResearchUrl(artifact.requestedUrl),
    canonicalResearchUrl(artifact.finalUrl)
  ])
}

function verifiedUrlsForStep(
  artifacts: ToolArtifact[],
  step: CriticalThinkingStepState
): Set<string> {
  const stepIds = new Set(step.evidenceIds)
  return new Set(
    artifacts.flatMap((artifact) =>
      artifact.kind === 'web-fetch' &&
      (stepIds.has(artifact.id) || artifact.research?.stepId === step.id) &&
      artifact.passages.length > 0
        ? [canonicalResearchUrl(artifact.finalUrl)]
        : []
    )
  )
}

function verifiedUrlCount(artifacts: ToolArtifact[]): number {
  return new Set(
    artifacts.flatMap((artifact) =>
      artifact.kind === 'web-fetch' && artifact.passages.length > 0
        ? [canonicalResearchUrl(artifact.finalUrl)]
        : []
    )
  ).size
}

function latestAcceptedAssessment(
  step: CriticalThinkingStepState,
  artifacts: ToolArtifact[]
): { finding: string } | null {
  const round = [...step.rounds]
    .reverse()
    .find((candidate) => candidate.status === 'completed' && candidate.assessment)
  if (!round?.assessment) return null
  const verified = verifiedUrlsForStep(artifacts, step).size
  return assessmentIsSufficient(round.assessment, verified) ? { finding: round.finding } : null
}

function stepHasReportableCoverage(
  step: CriticalThinkingStepState,
  artifacts: ToolArtifact[],
  sources: CriticalThinkingRun['sources']
): boolean {
  if (spentRoundCount(step) < 2) return false
  const finding = step.finding.replace(/\s+/g, ' ').trim()
  if (finding.length < 160 || (finding.match(/\S+/g)?.length ?? 0) < 25) return false
  // The phrase is stripped before the test because it names a SUBJECT, not a
  // disagreement between sources. Measured live: a creatine step titled "Audit
  // funding and conflicts of interest" carried five scholarly sources and a
  // 2,273-character finding, and was held back because its own topic word
  // matched a check looking for "the evidence contradicts itself".
  if (
    step.uncertainties.some((gap) =>
      UNRESOLVED_DISAGREEMENT.test(gap.replace(GAP_TOPIC_PHRASE, ' '))
    )
  ) {
    return false
  }

  const urls = verifiedUrlsForStep(artifacts, step)
  if (urls.size < 4) return false
  // Not "are the sources academic" but "are they better than junk".
  //
  // Requiring two scholarly-or-official sources tested the subject's domain
  // rather than the evidence's quality: for a commercial product the
  // storefront, the vendor's own site and the community forum are the primary
  // sources, and none of them is a journal or a .gov. Measured live, that made
  // `completed` unreachable for an entire subject area -- five Universe
  // Sandbox steps were marked `limited` carrying 2,100-3,000 character
  // findings over 9-15 verified pages, and a Bronze Age step was held back
  // with a museum, a specialist archaeology journal and a university among its
  // sources because only one of them ended in `.edu`.
  //
  // The bar this exists to hold is unchanged: an encyclopedia round-up or a
  // page of aggregator copy is still not a researched step.
  const substantialCount = sources.filter(
    (source) =>
      source.verified &&
      urls.has(canonicalResearchUrl(source.url)) &&
      !isWeakCriticalThinkingSource(source.url, source.title, source.snippet)
  ).length
  return substantialCount >= 2
}

/** Words meaning the evidence itself is at odds, not merely incomplete. */
const UNRESOLVED_DISAGREEMENT =
  /\b(contradict\w*|conflict\w*|sources? disagree|cannot answer|unresolved whether|opposing)\b/i

/**
 * A step whose SUBJECT is conflicts of interest is not a step whose sources
 * disagree. Stripped before the disagreement test rather than excluded from it,
 * so the word still counts everywhere it genuinely means a clash.
 */
const GAP_TOPIC_PHRASE = /conflicts?[-\s]of[-\s]interest/gi

function verifiedUrlsForRound(
  artifacts: ToolArtifact[],
  round: CriticalThinkingRoundState
): Set<string> {
  const roundIds = new Set(round.evidenceIds)
  return new Set(
    artifacts.flatMap((artifact) =>
      artifact.kind === 'web-fetch' &&
      (roundIds.has(artifact.id) || artifact.research?.roundId === round.id) &&
      artifact.passages.length > 0
        ? [canonicalResearchUrl(artifact.finalUrl)]
        : []
    )
  )
}

function researchIdentity(
  run: CriticalThinkingRun,
  roundId: string
): { stepId: string; roundId: string } {
  return { stepId: currentStep(run).id, roundId }
}

function artifactIdentity(conversationId: string): { conversationId: string; messageId: string } {
  return {
    conversationId,
    messageId: `critical_web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  }
}

function safeHostname(value: string): string {
  try {
    return new URL(value).hostname
  } catch {
    return truncate(value, 72)
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function stoppedDetail(reason: GenerationStopReason | undefined): string {
  return reason ? `Stopped: ${reason}` : 'Generation stopped before the phase completed'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Research operation failed.'
}

/**
 * True when at least one operation was attempted and every one of them failed.
 * A round in which every search or fetch failed (e.g. a burst of 403s — see
 * `webTools`' browser-header fix) is a step-level setback, not a run-ending
 * catastrophe: callers `limitStep` on it so the wave scheduler moves on and
 * the run can still synthesize whatever earlier steps verified. This must
 * never throw — an uncaught throw out of `run()` unwinds the entire
 * investigation into a reportless `failed`, which is exactly the bug this
 * replaced.
 */
function everyOperationFailed<T>(results: PromiseSettledResult<T>[]): boolean {
  return results.length > 0 && results.every((result) => result.status === 'rejected')
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function createLinkedTimeout(
  outerSignal: AbortSignal,
  timeoutMs: number
): {
  signal: AbortSignal
  timedOut: () => boolean
  dispose: () => void
} {
  const controller = new AbortController()
  let didTimeOut = false
  const onAbort = (): void => controller.abort(outerSignal.reason)
  if (outerSignal.aborted) controller.abort(outerSignal.reason)
  else outerSignal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    didTimeOut = true
    controller.abort('time-limit')
  }, timeoutMs)
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timer)
      outerSignal.removeEventListener('abort', onAbort)
    }
  }
}
