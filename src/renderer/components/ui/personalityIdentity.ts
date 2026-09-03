import type { ChatPersonality } from '@shared/chatPersonality'

/**
 * Name-derived bits of a personality's identity, kept out of the component so
 * the avatar file exports only a component (fast refresh) and so these can be
 * tested without a DOM.
 */

/** Word characters only: "Rook (mine)" must read RM, not "R(". */
export function personalityInitials(name: string): string {
  const parts = (name.trim() || 'Untitled').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/**
 * An unnamed personality still has to render somewhere — including in the chat
 * byline, which is where a blank would be most confusing.
 */
export function personalityDisplayName(personality: Pick<ChatPersonality, 'name'>): string {
  return personality.name.trim() || 'Untitled'
}
