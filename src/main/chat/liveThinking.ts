/**
 * The thinking written so far by every turn still running.
 *
 * A phone is sent thinking only while somebody has it open, so opening it partway
 * through a turn would otherwise show only what the model thinks from then on. This
 * is what it is sent first. Kept per conversation, because that is how a turn is
 * addressed, and dropped the moment the turn ends.
 */
const running = new Map<string, { messageId: string; text: string }>()

export function noteThinking(conversationId: string, messageId: string, token: string): void {
  const turn = running.get(conversationId)
  if (turn && turn.messageId === messageId) turn.text += token
  else running.set(conversationId, { messageId, text: token })
}

export function endThinking(conversationId: string, messageId: string): void {
  if (running.get(conversationId)?.messageId === messageId) running.delete(conversationId)
}

export function thinkingSoFar(): Array<{
  conversationId: string
  messageId: string
  text: string
}> {
  return [...running].map(([conversationId, turn]) => ({ conversationId, ...turn }))
}
