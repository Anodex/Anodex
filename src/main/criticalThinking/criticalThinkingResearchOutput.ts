import { randomUUID } from 'node:crypto'
import type { CriticalThinkingCoverageAssessment } from '@shared/criticalThinking.types'
import type { Plan } from '@shared/plan.types'

const MAX_QUERY_CHARS = 320
const MAX_FINDING_CHARS = 4_000
const MAX_RATIONALE_CHARS = 800
const MAX_GAP_CHARS = 360
const MIN_PLAN_STEPS = 3
const MAX_PLAN_STEPS = 7
const MAX_PLAN_TITLE_CHARS = 200
const MAX_PLAN_STEP_CHARS = 240

export interface ParsedResearchQueries {
  queries: string[]
  valid: boolean
}

export interface ParsedResearchPlan {
  plan: Plan | null
  valid: boolean
  /** Why the plan was rejected, when it was — fed into a bounded repair prompt. */
  issues: string[]
}

export interface ParsedResearchAssessment {
  finding: string
  uncertainties: string[]
  assessment: CriticalThinkingCoverageAssessment | null
  valid: boolean
}

export function parseResearchQueries(
  content: string,
  fallbackQuery: string,
  maxQueries: number
): ParsedResearchQueries {
  const boundedMaxQueries = boundedCount(maxQueries)
  if (boundedMaxQueries === 0) return { queries: [], valid: false }
  const parsed = parseJsonObject(content)
  const queries = boundStrings(parsed?.queries, boundedMaxQueries, MAX_QUERY_CHARS)
  if (queries.length > 0) {
    return {
      queries,
      valid: isNonEmptyStringArray(parsed?.queries) && parsed.queries.length <= boundedMaxQueries
    }
  }
  const fallback = truncate(normalizeInlineText(fallbackQuery), MAX_QUERY_CHARS)
  return { queries: fallback ? [fallback] : [], valid: false }
}

/**
 * Parses a bounded `{"title": "...", "steps": ["..."]}` plan proposal. IDs and
 * `updatedAt` are always generated here rather than trusted from model text —
 * the model only supplies title/step text.
 */
export function parseResearchPlan(content: string): ParsedResearchPlan {
  const parsed = parseJsonObject(content)
  if (!parsed) {
    return { plan: null, valid: false, issues: ['The response was not a valid JSON object.'] }
  }
  const title = truncate(normalizeInlineText(stringValue(parsed.title)), MAX_PLAN_TITLE_CHARS)
  const steps = boundStrings(parsed.steps, MAX_PLAN_STEPS, MAX_PLAN_STEP_CHARS)
  const issues: string[] = []
  if (!title) issues.push('The plan needs a non-empty title.')
  if (steps.length < MIN_PLAN_STEPS) {
    issues.push(`The plan needs at least ${MIN_PLAN_STEPS} distinct, concrete research steps.`)
  }
  if (issues.length > 0) return { plan: null, valid: false, issues }
  return {
    plan: {
      title,
      steps: steps.map((stepTitle) => ({
        id: randomUUID(),
        title: stepTitle,
        status: 'pending' as const
      })),
      updatedAt: Date.now()
    },
    valid: true,
    issues: []
  }
}

export function parseResearchAssessment(
  content: string,
  maxQueries: number
): ParsedResearchAssessment {
  const parsed = parseJsonObject(content)
  const finding = truncate(stringValue(parsed?.finding) || content.trim(), MAX_FINDING_CHARS)
  const uncertainties = boundStrings(parsed?.uncertainties, 8, MAX_GAP_CHARS)
  const verdict = validVerdict(parsed?.verdict)
  const evidenceBasis = validEvidenceBasis(parsed?.evidenceBasis)
  const rationale = truncate(stringValue(parsed?.rationale), MAX_RATIONALE_CHARS)
  const remainingGaps = boundStrings(parsed?.remainingGaps, 8, MAX_GAP_CHARS)
  const nextQueries = boundStrings(parsed?.nextQueries, maxQueries, MAX_QUERY_CHARS)
  const valid = Boolean(
    parsed &&
    finding &&
    rationale &&
    verdict &&
    evidenceBasis &&
    isNonEmptyStringArray(parsed.uncertainties) &&
    isNonEmptyStringArray(parsed.remainingGaps) &&
    isNonEmptyStringArray(parsed.nextQueries)
  )
  return {
    finding,
    uncertainties,
    assessment:
      valid && verdict && evidenceBasis
        ? { verdict, evidenceBasis, rationale, remainingGaps, nextQueries }
        : null,
    valid
  }
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim()
  const candidates = [trimmed]
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim()
  if (fence) candidates.push(fence)
  candidates.push(...extractJsonObjects(trimmed))
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try the next bounded representation.
    }
  }
  return null
}

function boundStrings(value: unknown, maxItems: number, maxChars: number): string[] {
  const boundedItems = boundedCount(maxItems)
  if (!Array.isArray(value) || boundedItems === 0) return []
  const seen = new Set<string>()
  const bounded: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = truncate(normalizeInlineText(item), maxChars)
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    bounded.push(text)
    if (bounded.length >= boundedItems) break
  }
  return bounded
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function truncate(value: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return ''
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && normalizeInlineText(item).length > 0)
  )
}

function validVerdict(value: unknown): CriticalThinkingCoverageAssessment['verdict'] | null {
  return value === 'continue' || value === 'sufficient' ? value : null
}

function validEvidenceBasis(
  value: unknown
): CriticalThinkingCoverageAssessment['evidenceBasis'] | null {
  return value === 'multiple-sources' ||
    value === 'authoritative-primary' ||
    value === 'insufficient'
    ? value
    : null
}

function boundedCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

/** Find balanced JSON objects without being confused by braces inside strings. */
function extractJsonObjects(value: string): string[] {
  const objects: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{') {
      if (depth === 0) start = index
      depth++
      continue
    }
    if (character !== '}' || depth === 0) continue
    depth--
    if (depth === 0 && start >= 0) {
      objects.push(value.slice(start, index + 1))
      start = -1
      if (objects.length >= 8) break
    }
  }
  return objects
}
