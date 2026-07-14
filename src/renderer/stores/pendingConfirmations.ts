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
