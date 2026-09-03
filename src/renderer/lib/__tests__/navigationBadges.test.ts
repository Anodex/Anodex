import { describe, expect, it } from 'vitest'
import {
  criticalThinkingAttention,
  formatNavigationBadgeCount,
  navigationBadgeCounts
} from '../navigationBadges'

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

/**
 * The run list dims what has been dealt with and leaves the rest bright, using
 * this same rule — so a badge saying "1" and the highlighted rows can never
 * disagree about which run it means.
 */
describe('criticalThinkingAttention', () => {
  const marker = 1_000

  it('keeps a plan awaiting approval lit however long ago it was looked at', () => {
    expect(criticalThinkingAttention({ status: 'needs-review', updatedAt: 1 }, marker)).toBe(
      'review'
    )
  })

  it('lights a finished run only until it has been seen', () => {
    expect(criticalThinkingAttention({ status: 'completed', updatedAt: 2_000 }, marker)).toBe('new')
    expect(criticalThinkingAttention({ status: 'completed', updatedAt: 500 }, marker)).toBeNull()
  })

  it('says nothing about a run still working', () => {
    expect(
      criticalThinkingAttention({ status: 'researching', updatedAt: 5_000 }, marker)
    ).toBeNull()
  })

  it('agrees with the badge count', () => {
    const runs = [
      { status: 'needs-review' as const, updatedAt: 1 },
      { status: 'completed' as const, updatedAt: 2_000 },
      { status: 'completed' as const, updatedAt: 500 }
    ]
    const lit = runs.filter((run) => criticalThinkingAttention(run, marker) !== null).length
    expect(lit).toBe(
      navigationBadgeCounts({
        tasks: [],
        agentRuns: [],
        criticalThinkingRuns: runs,
        emailUnreadCount: 0,
        seenAt: { scheduler: 0, agent: 0, 'critical-thinking': marker }
      }).criticalThinking
    )
  })
})
