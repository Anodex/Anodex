import type { AgentRun } from '@shared/agentRun.types'

/**
 * The conversations of the runs that changed between two announcements, or null
 * when the only safe answer is to read every conversation again.
 *
 * Null when a run went away, since removing a run can archive or delete its
 * conversation, and when a changed run has no conversation yet to name.
 */
export function conversationsOfChangedRuns(before: AgentRun[], after: AgentRun[]): string[] | null {
  const previous = new Map(before.map((run) => [run.id, run]))
  const current = new Set(after.map((run) => run.id))
  if (before.some((run) => !current.has(run.id))) return null

  const ids: string[] = []
  for (const run of after) {
    const was = previous.get(run.id)
    if (was && was.updatedAt === run.updatedAt && was.conversationId === run.conversationId)
      continue
    if (!run.conversationId) {
      if (was) continue
      return null
    }
    ids.push(run.conversationId)
    if (was?.conversationId && was.conversationId !== run.conversationId)
      ids.push(was.conversationId)
  }
  return ids
}
