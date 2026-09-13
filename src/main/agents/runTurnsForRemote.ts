import type { ChatMessage } from '@shared/chat.types'
import type { RemoteRunTurn } from '@shared/agentRun.types'

/** How much of one turn's reply a phone gets. Enough to read, far short of a transcript. */
export const RUN_TURN_TEXT_CHARS = 1_200

/** Tool rows per turn. A turn that ran more says how many it left out. */
export const RUN_TURN_TOOLS = 20

/**
 * A run's turns, as a phone can follow them.
 *
 * The phone's run card was a summary and a set of meters; opening a run dropped
 * you into its raw conversation, which `conversations:get` sends as text only — no
 * tool calls, no timings, because on an agent transcript those are most of the bytes.
 * Following a run means seeing each turn the way the desktop's run page shows it: a
 * reply, the tools it ran and whether they worked, how long it took.
 *
 * So each assistant message becomes one turn, cut to what that page puts on screen —
 * the reply (capped), tool names, titles and statuses (capped), tokens and wall time
 * — and the same health colour rule the page uses. Arguments, results and diffs stay
 * on the computer.
 */
export function runTurnsForRemote(messages: readonly ChatMessage[]): RemoteRunTurn[] {
  return messages
    .filter((message) => message.role === 'assistant')
    .map((message, index) => {
      const calls = message.toolCalls ?? []
      const text = message.content.trim()
      return {
        number: index + 1,
        messageId: message.id,
        text: text.length > RUN_TURN_TEXT_CHARS ? `${text.slice(0, RUN_TURN_TEXT_CHARS)}…` : text,
        tools: calls.slice(0, RUN_TURN_TOOLS).map((call) => ({
          name: call.name,
          title: call.title,
          status: call.status
        })),
        moreTools: Math.max(0, calls.length - RUN_TURN_TOOLS),
        tokens: message.stats?.tokens ?? null,
        durationMs: message.stats?.durationMs ?? null,
        health: turnHealth(message),
        error: message.error ?? null
      }
    })
}

/** The desktop run page's `turnDot`, so a turn looks equally healthy on both screens. */
function turnHealth(message: ChatMessage): RemoteRunTurn['health'] {
  if (message.error && message.errorKind !== 'bounded') return 'error'
  if (message.error) return 'warn'
  if (message.toolCalls?.some((call) => call.status === 'error' || call.status === 'denied')) {
    return 'warn'
  }
  return 'ok'
}
