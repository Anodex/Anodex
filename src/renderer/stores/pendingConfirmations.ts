import type { ToolConfirmRequest } from '@shared/tools.types'

/**
 * Append a newly-arrived confirmation request to the queue. A queue, not a
 * single slot — node-llama-cpp (and the cloud providers) can genuinely
 * invoke multiple guarded tool calls concurrently within one turn, so more
 * than one request can already be pending when this one arrives.
 */
export function appendPendingConfirmation(
  pending: ToolConfirmRequest[],
  request: ToolConfirmRequest
): ToolConfirmRequest[] {
  return [...pending, request]
}

/**
 * Remove a resolved request from the queue by id, leaving every other
 * pending request untouched. An unknown id is a safe no-op — returns the
 * same array reference so callers can skip a state update entirely.
 */
export function removePendingConfirmation(
  pending: ToolConfirmRequest[],
  id: string
): ToolConfirmRequest[] {
  if (!pending.some((request) => request.id === id)) return pending
  return pending.filter((request) => request.id !== id)
}

/**
 * `pendingConfirmations` is a single global queue, but a second conversation
 * (a different interactive chat generating concurrently — nothing prevents
 * starting a message in one conversation, switching away, and starting
 * another) can add its own requests to that same queue while the user is
 * looking at a different one. Without filtering by the conversation actually
 * on screen, `ToolConfirmCard` would render a mixed batch with no visual cue
 * that some cards belong elsewhere, and "Approve all"/"Deny all" would act on
 * every one of them — approving a write in a conversation the user never
 * looked at. Concurrent calls *within* one turn of the SAME conversation
 * (the actual reason this is a queue, not a single slot — see
 * `appendPendingConfirmation`) all share one `conversationId`, so they still
 * batch together correctly after this filter.
 */
export function confirmationsForConversation(
  pending: ToolConfirmRequest[],
  conversationId: string | null
): ToolConfirmRequest[] {
  if (!conversationId) return []
  return pending.filter((request) => request.conversationId === conversationId)
}
