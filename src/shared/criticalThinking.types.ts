import type { GenerationStats } from './chat.types'
import type { Plan } from './plan.types'
import type { ToolCallStatus } from './tools.types'

export type CriticalThinkingStatus =
  'planning' | 'needs-review' | 'researching' | 'done' | 'stopped' | 'error'

export type CriticalThinkingProvider = 'local' | 'anthropic' | 'openai'

export interface CriticalThinkingSource {
  title: string
  url: string
  snippet?: string
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
