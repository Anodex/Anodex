import type { AgentRun } from '@shared/agentRun.types'

/** A run, with any sub-agents it delegated shown underneath it. */
export interface RunNode {
  run: AgentRun
  children: AgentRun[]
}

/**
 * Arrange the visible runs so a parent's sub-agents sit under it.
 *
 * Grouping happens *after* filtering, over whatever the list is already
 * showing, and a child whose parent is not in that set is promoted to the top
 * level rather than dropped. Both halves matter:
 *
 * - Filtering first keeps the status filter meaning what it says. Group first
 *   and "done" would either hide finished sub-agents under a still-running
 *   parent, or drag an unfinished parent into a list of finished runs.
 * - Promoting orphans is why nothing can disappear. A sub-agent whose parent
 *   was filtered out, or deleted, is still a real run with a transcript, and a
 *   run that exists but appears nowhere is worse than one shown out of place.
 *
 * Order is preserved: parents keep the order they arrived in, and each
 * parent's children keep theirs.
 */
export function groupRunsByParent(runs: readonly AgentRun[]): RunNode[] {
  const visible = new Set(runs.map((run) => run.id))
  const nodes: RunNode[] = []
  const byId = new Map<string, RunNode>()

  for (const run of runs) {
    // An orphan is a top-level row: its parent is not on screen to nest under.
    if (run.parentRunId && visible.has(run.parentRunId)) continue
    const node: RunNode = { run, children: [] }
    nodes.push(node)
    byId.set(run.id, node)
  }
  for (const run of runs) {
    if (!run.parentRunId) continue
    byId.get(run.parentRunId)?.children.push(run)
  }
  return nodes
}

/**
 * What a parent's sub-agents are collectively doing, for the line on its card.
 *
 * The point of the feature is being able to see the fan-out at a glance
 * without opening anything, so this counts rather than lists — three tasks
 * spelled out would crowd the parent's own goal off the card.
 */
export function describeSubAgents(children: readonly AgentRun[]): string | null {
  if (children.length === 0) return null
  const running = children.filter((child) => child.status === 'running').length
  const failed = children.filter(
    (child) => child.status === 'error' || child.status === 'stopped'
  ).length
  const total = children.length
  const label = `${total} sub-agent${total === 1 ? '' : 's'}`
  if (running > 0) return `${label} · ${running} working`
  // Only worth saying once they have all stopped, when it is the outcome
  // rather than a progress report.
  if (failed > 0) return `${label} · ${failed} did not finish`
  return `${label} · all finished`
}
