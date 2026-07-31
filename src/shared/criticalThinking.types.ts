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
  issues: string[]
}

export interface CriticalThinkingSynthesisDiagnostics {
  startedAt: number
  completedAt: number | null
  verifiedSourceCount: number
  evidencePacketChars: number
  strategy: 'single-pass' | 'hierarchical-recovery' | 'deterministic-fallback'
  selectedStage: CriticalThinkingSynthesisStage | null
  attempts: CriticalThinkingSynthesisAttemptDiagnostic[]
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
