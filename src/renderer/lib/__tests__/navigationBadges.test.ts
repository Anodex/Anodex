import { describe, expect, it } from 'vitest'
import { formatNavigationBadgeCount, navigationBadgeCounts } from '../navigationBadges'

const seenAt = {
  scheduler: 100,
  agent: 100,
  'critical-thinking': 100
}

describe('navigationBadgeCounts', () => {
  it('counts unseen terminal results and unread email threads', () => {
    expect(
      navigationBadgeCounts({
        tasks: [{ lastRunAt: 99 }, { lastRunAt: 101 }, { lastRunAt: null }],
        agentRuns: [
          { status: 'running', updatedAt: 120 },
          { status: 'done', updatedAt: 99 },
          { status: 'error', updatedAt: 102 }
        ],
        criticalThinkingRuns: [
          { status: 'researching', updatedAt: 120 },
          { status: 'completed', updatedAt: 101 },
          { status: 'failed', updatedAt: 90 }
        ],
        emailUnreadCount: 7,
        seenAt
      })
    ).toEqual({
      scheduler: 1,
      agent: 1,
      criticalThinking: 1,
      email: 7
    })
  })

  it('keeps needs-review work counted even after its view was opened', () => {
    expect(
      navigationBadgeCounts({
        tasks: [],
        agentRuns: [{ status: 'needs-review', updatedAt: 1 }],
        criticalThinkingRuns: [{ status: 'needs-review', updatedAt: 1 }],
        emailUnreadCount: 0,
        seenAt
      })
    ).toMatchObject({
      agent: 1,
      criticalThinking: 1
    })
  })

  it.each([-4.8, Number.NaN])('normalizes invalid email count %s', (emailUnreadCount) => {
    expect(
      navigationBadgeCounts({
        tasks: [],
        agentRuns: [],
        criticalThinkingRuns: [],
        emailUnreadCount,
        seenAt
      }).email
    ).toBe(0)
  })
})

describe('formatNavigationBadgeCount', () => {
  it('caps large counts at 99+', () => {
    expect(formatNavigationBadgeCount(99)).toBe('99')
    expect(formatNavigationBadgeCount(100)).toBe('99+')
  })
})
