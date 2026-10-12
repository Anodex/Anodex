/**
 * Who the person using Anodex is, as the app greets and draws them.
 *
 * Shared because the desktop and the phone draw the same person: the phone's
 * `AvatarLooks` copies these colours, and the design contract does not cover them,
 * so they are listed once here with that warning attached.
 */

/**
 * The six avatar gradients offered in the welcome, from the mark's own colours.
 * Index 0 is the mark itself. Copied by the phone (`AvatarLooks.kt`): change both.
 */
export const AVATAR_LOOKS: readonly (readonly [string, string])[] = [
  ['#7c5cff', '#4f8cff'],
  ['#38bdf8', '#4f8cff'],
  ['#3ccf7a', '#0ea5a4'],
  ['#f5a623', '#f05a5a'],
  ['#ec4899', '#7c5cff'],
  ['#64748b', '#334155']
]

/** The name a fresh install starts with, which is nobody's name. */
export const PLACEHOLDER_NAME = 'Anodex User'

/** The CSS gradient for a look, falling back to the mark's for an unknown index. */
export function avatarGradient(look: number | undefined): string {
  const [from, to] = AVATAR_LOOKS[look ?? 0] ?? AVATAR_LOOKS[0]
  return `linear-gradient(135deg, ${from}, ${to})`
}

/**
 * The person's own first name, or null when they have not given one.
 *
 * Null for the placeholder too: "Good evening, Anodex." greets the app, not the
 * person, and a greeting is only worth showing when it is theirs.
 */
export function firstName(displayName: string | undefined | null): string | null {
  const name = (displayName ?? '').trim()
  if (!name || name === PLACEHOLDER_NAME) return null
  return name.split(/\s+/)[0]
}

/** Up to two initials, for an avatar with no photo. */
export function initialsOf(displayName: string | undefined | null): string {
  const name = (displayName ?? '').trim()
  if (!name || name === PLACEHOLDER_NAME) return ''
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('')
}

/** "morning", "afternoon" or "evening", by the hour on this computer's clock. */
export function partOfDay(date: Date = new Date()): 'morning' | 'afternoon' | 'evening' {
  const hour = date.getHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  return 'evening'
}
