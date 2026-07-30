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
  const finding = truncate(
    stringValue(parsed?.finding) || plainTextFallbackFinding(content),
    MAX_FINDING_CHARS
  )
  const uncertainties = boundStrings(parsed?.uncertainties, 8, MAX_GAP_CHARS)
  const verdict = validVerdict(parsed?.verdict)
  const evidenceBasis = validEvidenceBasis(parsed?.evidenceBasis)
  const rationale = truncate(stringValue(parsed?.rationale), MAX_RATIONALE_CHARS)
  const remainingGaps = boundStrings(parsed?.remainingGaps, 8, MAX_GAP_CHARS)
  const nextQueries = boundStrings(parsed?.nextQueries, maxQueries, MAX_QUERY_CHARS)
  // A well-formed structured decision is the core fields — a recognized
  // verdict and evidenceBasis plus a finding and rationale. The gap/query/
  // uncertainty arrays are supplementary detail, NOT validity gates: a
  // "sufficient" verdict legitimately carries no remaining gaps or follow-up
  // queries (the assessment prompt explicitly says to leave nextQueries empty
  // when sufficient). Requiring those arrays non-empty — as this used to —
  // rejected every correctly-formatted "sufficient" assessment, so a step
  // whose evidence was actually complete could never be marked sufficient and
  // instead burned rounds until a budget limit, surfacing as "A valid
  // evidence coverage assessment is still required." The verified-source-count
  // gate in `assessmentIsSufficient` still guards actual completion, so a
  // model can't shortcut to "sufficient" without the sources to back it.
  const valid = Boolean(parsed && finding && rationale && verdict && evidenceBasis)
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

/**
 * A model that answers in prose instead of the requested object still has a
 * usable finding in that prose, so unparseable output is kept as the finding
 * — but only when it is actually prose. Output that opens as a JSON object
 * and failed to parse is a *cut-off* object, not a finding: observed
 * directly, a step stored 1,110 characters of raw JSON ending mid-string
 * (`"remainingGaps":["Specific names of general contr`) as its finding, which
 * then travelled into the synthesis prompt as navigation context. Dropping it
 * leaves the step honestly empty instead.
 */
function plainTextFallbackFinding(content: string): string {
  const trimmed = content.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[') ? '' : trimmed
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

/**
 * Normalize an enum-ish token from a local model that doesn't always emit the
 * exact literal: lowercases, trims, collapses spaces/underscores to hyphens,
 * and drops trailing punctuation. So `"Sufficient."`, `"multiple sources"`,
 * and `"MULTIPLE_SOURCES"` all match. Deliberately does NOT invent synonym
 * mappings (e.g. `"primary"` → `"authoritative-primary"`) — only formatting
 * drift is forgiven, so a genuinely different value still fails to match.
 */
function normalizeEnumToken(value: unknown): string {
  return typeof value === 'string'
    ? value
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[.,;:]+$/, '')
    : ''
}

function validVerdict(value: unknown): CriticalThinkingCoverageAssessment['verdict'] | null {
  const token = normalizeEnumToken(value)
  return token === 'continue' || token === 'sufficient' ? token : null
}

function validEvidenceBasis(
  value: unknown
): CriticalThinkingCoverageAssessment['evidenceBasis'] | null {
  const token = normalizeEnumToken(value)
  return token === 'multiple-sources' ||
    token === 'authoritative-primary' ||
    token === 'insufficient'
    ? token
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
