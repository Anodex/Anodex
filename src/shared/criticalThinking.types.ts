import type { GenerationStats, GenerationStopReason } from './chat.types'
import type { Plan } from './plan.types'
import type { ToolCallStatus } from './tools.types'
import type { ProviderSettings } from './settings.types'
import type { Result } from './result'

export type CriticalThinkingStatus =
  | 'planning'
  | 'needs-review'
  | 'researching'
  | 'synthesizing'
  | 'validating'
  | 'completed'
  | 'partial'
  | 'stopped'
  | 'failed'

/**
 * Every provider a Critical Thinking run can pin at creation time — kept as
 * its own named type (rather than inlining `ProviderSettings['active']`
 * everywhere) since `CriticalThinkingRun.provider` is a per-run snapshot,
 * not a live setting, but it intentionally matches that full set 1:1 so a
 * run can pin any provider the rest of the app supports.
 */
export type CriticalThinkingProvider = ProviderSettings['active']

export type CriticalThinkingTerminationReason = GenerationStopReason | 'evidence-limit'

export interface CriticalThinkingSource {
  id: string
  title: string
  url: string
  snippet?: string
  /** True only after fetch_url captured page passages for this URL. */
  verified: boolean
}

export type CriticalThinkingRoundStatus =
  | 'querying'
  | 'searching'
  | 'reading'
  | 'assessing'
  | 'completed'
  | 'limited'
  | 'stopped'
  | 'failed'

export interface CriticalThinkingCoverageAssessment {
  verdict: 'continue' | 'sufficient'
  evidenceBasis: 'multiple-sources' | 'authoritative-primary' | 'insufficient'
  rationale: string
  remainingGaps: string[]
  nextQueries: string[]
}

export interface CriticalThinkingRoundState {
  id: string
  /** Zero-based across the lifetime of this step, including resumed attempts. */
  index: number
  status: CriticalThinkingRoundStatus
  queries: string[]
  selectedUrls: string[]
  evidenceIds: string[]
  finding: string
  assessment: CriticalThinkingCoverageAssessment | null
  terminationReason?: CriticalThinkingTerminationReason
  startedAt: number
  completedAt: number | null
}

/** Limits are pinned to a run so resume cannot silently change its behavior. */
export interface CriticalThinkingResearchPolicy {
  maxRoundsPerStep: number
  maxQueriesPerRound: number
  maxResultsPerQuery: number
  maxPagesPerRound: number
  searchConcurrency: number
  fetchConcurrency: number
  maxRoundsPerRun: number
  maxSearchesPerRun: number
  maxFetchesPerRun: number
  /** Lifetime cap; unlike attempt budgets, Resume does not reset this value. */
  maxVerifiedSourcesPerRun: number
  maxRunMs: number
}

export interface CriticalThinkingStepState {
  id: string
  title: string
  status: 'pending' | 'researching' | 'completed' | 'limited' | 'failed'
  attempts: number
  evidenceIds: string[]
  finding: string
  uncertainties: string[]
  rounds: CriticalThinkingRoundState[]
  terminationReason?: CriticalThinkingTerminationReason
  /**
   * Rounds already spent when this step was last reopened by a resume. The
   * per-step round cap counts from here, so resuming an exhausted step buys it
   * a fresh allowance instead of re-limiting it the moment it starts.
   */
  roundBudgetBase?: number
}

export interface CriticalThinkingActivity {
  id: string
  kind: 'planning' | 'search' | 'reading' | 'analysis'
  label: string
  status: ToolCallStatus
  detail?: string
  createdAt: number
}

export type CriticalThinkingSynthesisStage =
  | 'draft'
  | 'repair'
  | 'section'
  | 'section-repair'
  | 'section-fallback'
  | 'consistency'
  | 'overview'
  | 'chart'
  | 'hierarchical-report'
  | 'deterministic-fallback'

export interface CriticalThinkingSynthesisAttemptDiagnostic {
  stage: CriticalThinkingSynthesisStage
  stepId?: string
  contentChars: number
  /** Bounded visible output retained locally so a failed report can be diagnosed after restart. */
  content: string
  /**
   * Hidden-reasoning characters this attempt produced, when the provider
   * reports them. The pair (`contentChars`, `thinkingChars`) is what
   * distinguishes "the model wrote a bad report" from "the model spent its
   * whole output budget thinking and never started one" — the live failure
   * that produced a zero-character report from 53 verified sources. Undefined
   * for a model or provider that reports no separate reasoning.
   */
  thinkingChars?: number
  stopReason?: GenerationStopReason
  safe: boolean
  usable: boolean
  valid: boolean
  citedBlockCount: number
  /**
   * The report-contract (structural) issues alone.
   *
   * `issues` mixes citation and contract issues and is capped at 24; a report
   * with 24 unverified quotations therefore pushed every structural issue off
   * the end, so a run recorded as `structurally-invalid` stored nothing saying
   * which section was missing. Kept separate rather than reordered, because
   * the order of `issues` is also what the repair prompt is built from.
   */
  contractIssues?: string[]
  issues: string[]
}

export interface CriticalThinkingSynthesisDiagnostics {
  startedAt: number
  completedAt: number | null
  verifiedSourceCount: number
  evidencePacketChars: number
  /**
   * Verified passage characters the run held, against which
   * `evidencePacketChars` is the share the model actually saw. Recorded so the
   * single-pass/hierarchical decision can be checked after the fact rather
   * than reconstructed from the evidence store -- see
   * `criticalThinkingRecoveryDecision.ts`. 0 on runs recorded before this
   * existed.
   */
  evidenceCorpusChars: number
  strategy: 'single-pass' | 'hierarchical-recovery' | 'deterministic-fallback'
  /**
   * The stage that produced the prose that shipped. Deliberately not set to
   * `'chart'`: a chart is appended to whichever report won, so recording it
   * here erased which stage actually wrote the report -- and, since a recovered
   * stage is what demotes a run to `partial`, an assembled-from-excerpts report
   * that happened to carry a number could report as an unqualified success.
   */
  selectedStage: CriticalThinkingSynthesisStage | null
  /** Whether an evidence chart was appended to the selected report. */
  chartAdded: boolean
  attempts: CriticalThinkingSynthesisAttemptDiagnostic[]
  /** Why the run finished `completed` or `partial`. Absent until it finishes. */
  completion?: CriticalThinkingCompletionDiagnostic
}

/**
 * The completion verdict, decomposed.
 *
 * A run that had researched every step and shipped the model's own report still
 * read `partial`, and nothing stored said which of the four conditions had
 * failed -- the attempt issues are recorded, but the counts the verdict is
 * actually computed from are not, and the stored report is the neutralised,
 * disclosed, citation-rendered one rather than the candidate that was judged.
 * Working it out meant re-deriving it from truncated attempt text.
 *
 * This is a record of a decision already made, not a new check.
 */
export interface CriticalThinkingCompletionDiagnostic {
  /** Each condition `completed` requires, as it was evaluated. */
  usable: boolean
  structurallyValid: boolean
  limitedSteps: boolean
  recoveredStage: boolean
  repairStopped: boolean
  /** The counts `usable` is computed from, so a false verdict names its cause. */
  otherSafetyIssueCount: number
  unverifiedQuotationCount: number
  unverifiedFigureCount: number
  citedSubstantiveBlockCount: number
  /** The conditions that were not met, in the order the verdict tests them. */
  blockers: string[]
}

/** A persisted Critical Thinking investigation and its final evidence-backed report. */
export interface CriticalThinkingRun {
  id: string
  question: string
  status: CriticalThinkingStatus
  provider: CriticalThinkingProvider
  /** Cloud model pinned when the run is created; local runs use the loaded model. */
  model: string | null
  researchPolicy: CriticalThinkingResearchPolicy
  /**
   * Verified sources already gathered when this run was last resumed. The
   * run's evidence ceiling counts from here, so resuming an investigation that
   * has reached it buys a fresh allowance rather than stopping immediately.
   */
  evidenceBudgetBase?: number
  plan: Plan | null
  report: string
  sources: CriticalThinkingSource[]
  steps: CriticalThinkingStepState[]
  currentStep: number
  evidenceCount: number
  activities: CriticalThinkingActivity[]
  stats: GenerationStats | null
  synthesisDiagnostics?: CriticalThinkingSynthesisDiagnostics | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface CreateCriticalThinkingRequest {
  question: string
}

export interface ApproveCriticalThinkingRequest {
  plan: Plan
}

export interface CriticalThinkingStreamChunk {
  runId: string
  token: string
}

/** Rendered report markup sent to main for a report-only PDF export. */
export interface ExportCriticalThinkingPdfRequest {
  question: string
  reportHtml: string
}

/** A null path means the user closed the save dialog without exporting. */
export type ExportCriticalThinkingPdfResult = Result<string | null>
