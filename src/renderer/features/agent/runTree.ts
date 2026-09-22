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

/** Where a run sits in the ongoing work it belongs to. */
export interface SeriesPlace {
  /** 1-based, oldest first. */
  position: number
  total: number
}

/**
 * Which runs continue earlier work, and where each one sits.
 *
 * Only series with more than one run are described. A lone run *is* a series
 * of one, so saying "run 1 of 1" on every card would be true and useless —
 * the label exists to mark the runs where something carried over, and a mark
 * that appears on everything marks nothing.
 *
 * Counted across every run in the store rather than the filtered view: a
 * series' length is a fact about the work, not about what the list happens
 * to be showing, and "run 2 of 2" flicking to "run 2 of 5" when a filter
 * changes would describe the filter rather than the work.
 */
export function seriesPlaces(runs: readonly AgentRun[]): Map<string, SeriesPlace> {
  const bySeries = new Map<string, AgentRun[]>()
  for (const run of runs) {
    // A sub-agent belongs to its parent's run, not to the series: it is a
    // step inside one chapter rather than a chapter of its own.
    if (run.parentRunId) continue
    const series = run.seriesId ?? run.id
    const existing = bySeries.get(series)
    if (existing) existing.push(run)
    else bySeries.set(series, [run])
  }

  const places = new Map<string, SeriesPlace>()
  for (const members of bySeries.values()) {
    if (members.length < 2) continue
    const oldestFirst = [...members].sort((a, b) => a.createdAt - b.createdAt)
    oldestFirst.forEach((run, index) => {
      places.set(run.id, { position: index + 1, total: oldestFirst.length })
    })
  }
  return places
}
