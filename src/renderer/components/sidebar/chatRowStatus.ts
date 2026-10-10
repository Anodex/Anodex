import type { Conversation } from '@shared/conversation.types'
import type { ToolCall } from '@shared/tools.types'
import { liveActivityLabel } from '../../features/chat/taskPhase'

/** The second line of a sidebar chat row, when there is something to say there. */
export interface ChatRowStatus {
  text: string
  /** `live` while the chat is working; `changed` for a finished one not yet opened. */
  tone: 'live' | 'changed'
}

/**
 * What a chat row says under its title.
 *
 * A working chat already had a scanning beam, which says *that* it is working
 * but not *what* it is doing, so a chat running in the background could only be
 * checked by opening it. It now says the same words the indicator under the
 * running reply does ("Reading camera.py"), drawn from the same tool calls, so
 * the two can never disagree. Those words change when a tool starts or ends,
 * not on every token.
 *
 * A finished chat that changed files says so once ("Changed 4 files"), until
 * it is opened, which is when its unread mark clears too.
 */
export function chatRowStatus(
  conversation: Pick<Conversation, 'messages'>,
  running: boolean,
  unread: boolean
): ChatRowStatus | null {
  const { messages } = conversation
  if (running) {
    const live = findLast(messages, (message) => message.streaming === true)
    if (!live) return null
    return {
      text: liveActivityLabel(live.toolCalls ?? [], live.content.trim().length > 0),
      tone: 'live'
    }
  }
  if (!unread) return null
  const reply = findLast(messages, (message) => message.role === 'assistant')
  const changed = changedFileCount(reply?.toolCalls ?? [])
  if (changed === 0) return null
  return { text: `Changed ${changed} file${changed === 1 ? '' : 's'}`, tone: 'changed' }
}

/** Files a turn actually changed: settled, successful writes, each path once. */
export function changedFileCount(calls: readonly ToolCall[]): number {
  const paths = new Set<string>()
  for (const call of calls) {
    if (call.kind !== 'write' || call.status !== 'success') continue
    for (const path of call.touchedPaths ?? (call.diff ? [call.diff.path] : [])) paths.add(path)
  }
  return paths.size
}

function findLast<T>(items: readonly T[], test: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    if (test(items[index])) return items[index]
  }
  return undefined
}
