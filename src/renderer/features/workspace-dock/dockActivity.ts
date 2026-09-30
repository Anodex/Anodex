import type { ChatMessage } from '@shared/chat.types'
import type { Plan } from '@shared/plan.types'
import type { ToolCall } from '@shared/tools.types'

/** One tool call in the conversation, with the time of the turn that made it. */
export interface DockActivityItem {
  call: ToolCall
  at: number
}

/** A file this conversation created, changed, moved, or deleted, most recent first. */
export interface DockOutput {
  path: string
  /** The call that last touched it. */
  title: string
  at: number
}

/** Every tool call in the conversation, newest first. */
export function activityOf(messages: ChatMessage[] | undefined): DockActivityItem[] {
  const items: DockActivityItem[] = []
  for (const message of messages ?? []) {
    for (const call of message.toolCalls ?? []) items.push({ call, at: message.createdAt })
  }
  return items.reverse()
}

/** Whether a tool is running right now, which the dock shows as a live dot. */
export function isWorking(messages: ChatMessage[] | undefined): boolean {
  return (messages ?? []).some((message) =>
    (message.toolCalls ?? []).some((call) => call.status === 'running')
  )
}

/**
 * The files this conversation's successful tool calls touched, each once, most
 * recent first. `touchedPaths` is the tools' own record of what changed, so
 * this follows deletes and moves too, which carry no diff.
 */
export function outputsOf(activity: DockActivityItem[]): DockOutput[] {
  const seen = new Set<string>()
  const outputs: DockOutput[] = []
  for (const { call, at } of activity) {
    if (call.status !== 'success') continue
    for (const path of call.touchedPaths ?? []) {
      if (seen.has(path)) continue
      seen.add(path)
      outputs.push({ path, title: call.title, at })
    }
  }
  return outputs
}

/** A plan's progress, for its tab badge. */
export function planProgress(
  plan: Plan | null | undefined
): { done: number; total: number } | null {
  if (!plan || plan.steps.length === 0) return null
  return {
    done: plan.steps.filter((step) => step.status === 'completed').length,
    total: plan.steps.length
  }
}

/**
 * A tool's path argument as a person would say it. Tools name the project's
 * top folder ".", which reads as a stray full stop in a list.
 */
export function readablePath(path: string): string {
  const trimmed = path.trim()
  return trimmed === '.' || trimmed === './' || trimmed === '' ? 'project root' : path
}
