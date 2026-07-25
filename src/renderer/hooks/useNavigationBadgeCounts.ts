import { useEffect } from 'react'
import { useAgentStore } from '../stores/agentStore'
import { useCriticalThinkingStore } from '../stores/criticalThinkingStore'
import { useEmailStore } from '../stores/emailStore'
import { useSchedulerStore } from '../stores/schedulerStore'
import { useUiStore } from '../stores/uiStore'
import {
  navigationBadgeCounts,
  type NavigationBadgeCounts,
  type NotificationView
} from '../lib/navigationBadges'

/**
 * How often the unread count is re-checked. Each poll is one lightweight
 * provider call, and for IMAP it now rides a pooled connection — but it is
 * still network traffic, so this stays comfortably above a per-minute cadence.
 */
const EMAIL_POLL_MS = 5 * 60_000

function latestSchedulerRunAt(): number {
  return Math.max(0, ...useSchedulerStore.getState().tasks.map((task) => task.lastRunAt ?? 0))
}

function latestAgentUpdateAt(): number {
  return Math.max(0, ...useAgentStore.getState().runs.map((run) => run.updatedAt))
}

function latestCriticalThinkingUpdateAt(): number {
  return Math.max(0, ...useCriticalThinkingStore.getState().runs.map((run) => run.updatedAt))
}

/** Live notification counts shared by the full sidebar and collapsed rail. */
export function useNavigationBadgeCounts(): NavigationBadgeCounts {
  const view = useUiStore((state) => state.view)
  const seenAt = useUiStore((state) => state.navigationSeenAt)
  const markNavigationSeen = useUiStore((state) => state.markNavigationSeen)
  const tasks = useSchedulerStore((state) => state.tasks)
  const schedulerLoaded = useSchedulerStore((state) => state.loaded)
  const agentRuns = useAgentStore((state) => state.runs)
  const agentLoaded = useAgentStore((state) => state.loaded)
  const criticalThinkingRuns = useCriticalThinkingStore((state) => state.runs)
  const criticalThinkingLoaded = useCriticalThinkingStore((state) => state.loaded)
  const emailUnreadCount = useEmailStore((state) => state.unreadCount)
  const refreshEmailUnread = useEmailStore((state) => state.refreshUnreadCount)

  // The email badge used to populate only when the Email page mounted, so a
  // freshly launched app claimed zero unread until the user went looking.
  // Polling here — the one place the count is actually displayed — keeps it
  // truthful without the Email view needing to be open.
  useEffect(() => {
    void refreshEmailUnread()
    const timer = window.setInterval(() => void refreshEmailUnread(), EMAIL_POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshEmailUnread])

  const schedulerUpdateAt = Math.max(0, ...tasks.map((task) => task.lastRunAt ?? 0))
  const agentUpdateAt = Math.max(0, ...agentRuns.map((run) => run.updatedAt))
  const criticalThinkingUpdateAt = Math.max(0, ...criticalThinkingRuns.map((run) => run.updatedAt))

  useEffect(() => {
    const notificationView: NotificationView | null =
      view === 'scheduler' || view === 'agent' || view === 'critical-thinking' ? view : null
    if (!notificationView) return

    const loaded =
      notificationView === 'scheduler'
        ? schedulerLoaded
        : notificationView === 'agent'
          ? agentLoaded
          : criticalThinkingLoaded
    if (!loaded) return

    const latestUpdateAt =
      notificationView === 'scheduler'
        ? latestSchedulerRunAt()
        : notificationView === 'agent'
          ? latestAgentUpdateAt()
          : latestCriticalThinkingUpdateAt()
    markNavigationSeen(notificationView, Math.max(Date.now(), latestUpdateAt))
  }, [
    agentLoaded,
    agentUpdateAt,
    criticalThinkingLoaded,
    criticalThinkingUpdateAt,
    markNavigationSeen,
    schedulerLoaded,
    schedulerUpdateAt,
    view
  ])

  return navigationBadgeCounts({
    tasks,
    agentRuns,
    criticalThinkingRuns,
    emailUnreadCount,
    seenAt
  })
}
