import type { GenerationStats, GenerationStopReason } from './chat.types'
import type { Plan } from './plan.types'
import type { ToolCallStatus } from './tools.types'
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

export type CriticalThinkingProvider = 'local' | 'anthropic' | 'openai'

export interface CriticalThinkingSource {
  id: string
  title: string
  url: string
  snippet?: string
  /** True only after fetch_url captured page passages for this URL. */
  verified: boolean
}

export interface CriticalThinkingStepState {
  id: string
  title: string
  status: 'pending' | 'researching' | 'completed' | 'limited' | 'failed'
  attempts: number
  evidenceIds: string[]
  finding: string
  uncertainties: string[]
  terminationReason?: GenerationStopReason
}

export interface CriticalThinkingActivity {
  id: string
  kind: 'planning' | 'search' | 'reading'
  label: string
  status: ToolCallStatus
  detail?: string
  createdAt: number
}

/** A persisted Critical Thinking investigation and its final evidence-backed report. */
export interface CriticalThinkingRun {
  id: string
  question: string
  status: CriticalThinkingStatus
  provider: CriticalThinkingProvider
  /** Cloud model pinned when the run is created; local runs use the loaded model. */
  model: string | null
  plan: Plan | null
  report: string
  sources: CriticalThinkingSource[]
  steps: CriticalThinkingStepState[]
  currentStep: number
  evidenceCount: number
  activities: CriticalThinkingActivity[]
  stats: GenerationStats | null
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
