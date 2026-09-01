import type { CriticalThinkingSource } from '@shared/criticalThinking.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import { evaluateHierarchicalSection } from './criticalThinkingHierarchicalReport'

const MAX_CORRECTIONS = 6
const ABSOLUTE_CLAIM =
  /\b(no (?:published )?evidence|no studies|non-?existent|completely absent|entirely absent|only (?:evidence|study|data|source)|unique to|never|always)\b/i

export interface CriticalThinkingConsistencyCorrection {
  stepId: string
  find: string
  replace: string
}

export interface CriticalThinkingConsistencyApplication {
  sections: Map<string, string>
  accepted: number
  issues: string[]
}

export function sectionsNeedConsistencyReview(sections: Map<string, string>): boolean {
  return sections.size > 1 && [...sections.values()].some((section) => ABSOLUTE_CLAIM.test(section))
}

export function parseCriticalThinkingConsistencyReview(
  content: string
): CriticalThinkingConsistencyCorrection[] | null {
  const trimmed = content.trim()
  const candidates = [trimmed]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim()
  if (fenced) candidates.push(fenced)
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (!isRecord(parsed) || !Array.isArray(parsed.corrections)) continue
      const corrections = parsed.corrections.slice(0, MAX_CORRECTIONS).flatMap((item) => {
        if (!isRecord(item)) return []
        const stepId = stringValue(item.stepId, 160)
        const find = stringValue(item.find, 800)
        const replace = stringValue(item.replace, 1_200)
        if (
          !stepId ||
          find.length < 20 ||
          replace.length < 20 ||
          !/\[\[S\d+(?::P\d+)?\]\]/.test(replace)
        ) {
          return []
        }
        return [{ stepId, find, replace }]
      })
      return corrections
    } catch {
      // Try the next bounded JSON representation.
    }
  }
  return null
}

export function applyCriticalThinkingConsistencyCorrections(
  sections: Map<string, string>,
  corrections: CriticalThinkingConsistencyCorrection[],
  artifacts: ToolArtifact[],
  sources: CriticalThinkingSource[],
  /**
   * The run's question. Both candidates are judged against it, so a correction
   * is never rejected merely for restating a figure the question supplied.
   */
  question?: string
): CriticalThinkingConsistencyApplication {
  const revised = new Map(sections)
  const issues: string[] = []
  let accepted = 0
  for (const correction of corrections.slice(0, MAX_CORRECTIONS)) {
    const current = revised.get(correction.stepId)
    if (!current || !current.includes(correction.find)) {
      issues.push(`Correction target was not an exact retained sentence for ${correction.stepId}.`)
      continue
    }
    const original = evaluateHierarchicalSection(current, artifacts, sources, question)
    const candidateText = current.replace(correction.find, correction.replace)
    const candidate = evaluateHierarchicalSection(candidateText, artifacts, sources, question)
    if (
      !candidate.safe ||
      !candidate.usable ||
      candidate.citedBlockCount < original.citedBlockCount ||
      candidate.issues.length > original.issues.length
    ) {
      issues.push(`Correction for ${correction.stepId} did not pass evidence validation.`)
      continue
    }
    revised.set(correction.stepId, candidate.content)
    accepted++
  }
  return { sections: revised, accepted, issues }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stringValue(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : ''
}
