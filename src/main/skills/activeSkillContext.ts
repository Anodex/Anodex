import type { Skill } from '@shared/skill.types'

const MAX_ACTIVE_SKILLS = 5

/**
 * Longest skill body injected verbatim when pinned; anything past this is
 * elided. Exported so skills shipped with the app can be checked against the
 * real limit rather than a copy of the number.
 */
export const MAX_SKILL_BODY_CHARS = 1800

/**
 * Format user-pinned skills for automatic injection into the system prompt.
 * Pinned skills are an explicit project setting, so their instructions are
 * treated as active workflow guidance rather than passive search results.
 */
export function buildActiveSkillContext(
  skills: Skill[],
  pinnedSkillNames: string[]
): string | null {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const active = pinnedSkillNames
    .map((name) => byName.get(name))
    .filter((skill): skill is Skill => Boolean(skill))
    .slice(0, MAX_ACTIVE_SKILLS)

  if (active.length === 0) return null

  return active
    .map((skill) => {
      const body = skill.body.trim()
      const trimmedBody =
        body.length > MAX_SKILL_BODY_CHARS
          ? `${body.slice(0, MAX_SKILL_BODY_CHARS).trimEnd()}…`
          : body
      return [`## ${skill.name}`, skill.description, trimmedBody].filter(Boolean).join('\n\n')
    })
    .join('\n\n')
}
