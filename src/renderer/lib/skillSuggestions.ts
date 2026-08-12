import type { SkillSummary } from '@shared/skill.types'

const MIN_QUERY_LENGTH = 3
const SKILL_PREFIX_RE = /^Use the `([^`]+)` skill for this request\.\n\n/

export interface SkillSuggestionOptions {
  limit?: number
  pinnedSkillNames?: string[]
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_QUERY_LENGTH)
}

function skillText(skill: SkillSummary): string {
  return [skill.name, skill.description, ...skill.keywords].join(' ').toLowerCase()
}

function scoreSkill(skill: SkillSummary, queryTerms: string[]): number {
  const haystack = skillText(skill)
  let score = 0
  for (const term of queryTerms) {
    if (skill.name.toLowerCase().includes(term)) score += 4
    else if (skill.keywords.some((keyword) => keyword.toLowerCase().includes(term))) score += 3
    else if (haystack.includes(term)) score += 1
  }
  return score
}

function orderSkills(
  entries: Array<{ skill: SkillSummary; score: number }>,
  pinnedSkillNames: readonly string[]
): SkillSummary[] {
  const pinned = new Set(pinnedSkillNames)
  return entries
    .sort((a, b) => {
      const aPinned = pinned.has(a.skill.name)
      const bPinned = pinned.has(b.skill.name)
      if (aPinned !== bPinned) return aPinned ? -1 : 1
      if (b.score !== a.score) return b.score - a.score
      if (a.skill.scope !== b.skill.scope) return a.skill.scope === 'project' ? -1 : 1
      return a.skill.name.localeCompare(b.skill.name)
    })
    .map((entry) => entry.skill)
}

/**
 * Lightweight renderer-side skill matching for a compact composer hint. The
 * model still decides whether to call find_skill/load_skill; this only helps
 * the user discover that a relevant reusable workflow exists.
 */
export function getSkillSuggestions(
  skills: SkillSummary[],
  text: string,
  options: number | SkillSuggestionOptions = 2
): SkillSummary[] {
  const limit = typeof options === 'number' ? options : (options.limit ?? 2)
  const pinnedSkillNames = typeof options === 'number' ? [] : (options.pinnedSkillNames ?? [])
  const queryTerms = tokenize(text)
  if (queryTerms.length === 0) return []

  return orderSkills(
    skills
      .map((skill) => ({ skill, score: scoreSkill(skill, queryTerms) }))
      .filter((entry) => entry.score > 0),
    pinnedSkillNames
  ).slice(0, limit)
}

/**
 * Find skills for the slash picker. A bare `/` lists the available workflows;
 * after that, matching uses the skill name, keywords, and description so a
 * user can discover a skill without remembering its exact name.
 */
export function getSlashSkillSuggestions(
  skills: SkillSummary[],
  text: string,
  options: SkillSuggestionOptions = {}
): SkillSummary[] {
  const match = /^\/([^\s]*)$/.exec(text)
  if (!match) return []

  const query = match[1].toLowerCase()
  const limit = options.limit ?? 8
  return orderSkills(
    skills
      .map((skill) => {
        if (!query) return { skill, score: 1 }
        const name = skill.name.toLowerCase()
        const haystack = skillText(skill)
        const score = name.startsWith(query)
          ? 6
          : name.includes(query)
            ? 4
            : skill.keywords.some((keyword) => keyword.toLowerCase().includes(query))
              ? 3
              : haystack.includes(query)
                ? 1
                : 0
        return { skill, score }
      })
      .filter((entry) => entry.score > 0),
    options.pinnedSkillNames ?? []
  ).slice(0, limit)
}

export function getAppliedSkillName(text: string): string | null {
  return text.trimStart().match(SKILL_PREFIX_RE)?.[1] ?? null
}

export function applySkillSuggestion(skillName: string, text: string): string {
  const trimmed = text.trimStart()
  const current = getAppliedSkillName(trimmed)
  if (current === skillName) return text
  const withoutExisting = trimmed.replace(SKILL_PREFIX_RE, '')
  return `Use the \`${skillName}\` skill for this request.\n\n${withoutExisting}`
}
