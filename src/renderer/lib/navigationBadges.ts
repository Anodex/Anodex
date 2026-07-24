import type { AgentRunStatus } from '@shared/agentRun.types'
import type { CriticalThinkingStatus } from '@shared/criticalThinking.types'

export type NotificationView = 'scheduler' | 'agent' | 'critical-thinking'

export interface NavigationSeenAt {
  scheduler: number
  agent: number
  'critical-thinking': number
}

export interface NavigationBadgeCounts {
  scheduler: number
  agent: number
  criticalThinking: number
  email: number
}

interface SchedulerNotification {
  lastRunAt: number | null
}

interface AgentNotification {
  status: AgentRunStatus
  updatedAt: number
}

interface CriticalThinkingNotification {
  status: CriticalThinkingStatus
  updatedAt: number
}

interface NavigationBadgeInput {
  tasks: SchedulerNotification[]
  agentRuns: AgentNotification[]
  criticalThinkingRuns: CriticalThinkingNotification[]
  emailUnreadCount: number
  seenAt: NavigationSeenAt
}

const AGENT_TERMINAL_STATUSES = new Set<AgentRunStatus>(['done', 'stopped', 'error'])
const CRITICAL_THINKING_TERMINAL_STATUSES = new Set<CriticalThinkingStatus>([
  'completed',
  'partial',
  'stopped',
  'failed'
])

/**
 * Count only unseen terminal results plus work that still requires a decision.
 * Needs-review items remain visible after opening their view because looking at
 * an approval request is not the same thing as resolving it.
 */
export function navigationBadgeCounts(input: NavigationBadgeInput): NavigationBadgeCounts {
  const emailUnreadCount = Number.isFinite(input.emailUnreadCount)
    ? Math.max(0, Math.floor(input.emailUnreadCount))
    : 0

  return {
    scheduler: input.tasks.filter(
      (task) => task.lastRunAt !== null && task.lastRunAt > input.seenAt.scheduler
    ).length,
    agent: input.agentRuns.filter(
      (run) =>
        run.status === 'needs-review' ||
        (AGENT_TERMINAL_STATUSES.has(run.status) && run.updatedAt > input.seenAt.agent)
    ).length,
    criticalThinking: input.criticalThinkingRuns.filter(
      (run) =>
        run.status === 'needs-review' ||
        (CRITICAL_THINKING_TERMINAL_STATUSES.has(run.status) &&
          run.updatedAt > input.seenAt['critical-thinking'])
    ).length,
    email: emailUnreadCount
  }
}

export function formatNavigationBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}
