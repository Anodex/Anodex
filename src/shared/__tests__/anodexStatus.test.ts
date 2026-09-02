import { describe, expect, it } from 'vitest'
import {
  renderAnodexStatus,
  type AnodexStatusSnapshot,
  type AnodexStatusSection
} from '../anodexStatus'

/**
 * What Anodex says when asked about itself.
 *
 * Two properties matter more than the exact wording. First, an empty section
 * must say so plainly — "no scheduled tasks" is a real answer, and a blank
 * section is the kind of silence a model fills with a guess. Second, a long
 * list must be capped and must admit it: this text lands in a chat context
 * routinely 8,192 tokens wide, and a hundred rendered tasks would evict the
 * conversation that asked for them.
 *
 * The email section is tested for what it does *not* contain. Whether an
 * account is linked is configuration; what is in it is correspondence, and a
 * vague "how are things?" must never be a way to page through an inbox.
 */
const NOW = new Date('2026-09-02T12:00:00Z').getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function snapshot(overrides: Partial<AnodexStatusSnapshot> = {}): AnodexStatusSnapshot {
  return {
    now: NOW,
    scheduler: [],
    agents: [],
    criticalThinking: [],
    projects: [],
    email: [],
    ...overrides
  }
}

const task = (over: Partial<AnodexStatusSnapshot['scheduler'][number]> = {}) => ({
  name: 'Morning inbox summary',
  enabled: true,
  schedule: 'Every weekday at 9:00 AM',
  nextRunAt: NOW + 3 * HOUR,
  lastRunAt: NOW - 21 * HOUR,
  lastRunStatus: 'success',
  ...over
})

describe('renderAnodexStatus', () => {
  describe('overview', () => {
    it('reports every area in a handful of lines', () => {
      const text = renderAnodexStatus(
        snapshot({
          projects: [
            { name: 'Universe Sandbox', isActive: true },
            { name: 'Bench', isActive: false }
          ],
          scheduler: [task(), task({ name: 'Weekly digest', enabled: false })],
          agents: [
            {
              goal: 'Add a moon',
              status: 'running',
              turnsUsed: 4,
              maxTurns: 30,
              updatedAt: NOW - MINUTE,
              projectName: 'Universe Sandbox'
            }
          ],
          criticalThinking: [
            {
              question: 'Do heat pumps work in cold climates?',
              status: 'completed',
              sourceCount: 12,
              updatedAt: NOW - 2 * DAY
            }
          ],
          email: [{ address: 'a@example.com', provider: 'gmail' }]
        }),
        'overview'
      )

      expect(text).toContain('active: Universe Sandbox')
      expect(text).toContain('2 tasks, 1 enabled')
      expect(text).toContain('1 running now')
      expect(text).toContain('Email accounts linked: 1')
      // Short enough to be worth asking for casually.
      expect(text.split('\n').length).toBeLessThanOrEqual(12)
    })

    it('says a run is read-only so the model does not offer to change things', () => {
      expect(renderAnodexStatus(snapshot(), 'overview')).toContain('read-only')
    })

    it('names the sections that hold more detail', () => {
      // Without this the model has no way to know a second call is available.
      const text = renderAnodexStatus(snapshot(), 'overview')
      for (const section of ['scheduler', 'agents', 'critical-thinking', 'projects', 'email']) {
        expect(text).toContain(section)
      }
    })

    it('states plainly when nothing is set up at all', () => {
      const text = renderAnodexStatus(snapshot(), 'overview')
      expect(text).toContain('none open')
      expect(text).toContain('0 tasks')
      expect(text).toContain('Email accounts linked: 0')
    })

    it('defaults to the overview when no section is given', () => {
      expect(renderAnodexStatus(snapshot())).toBe(renderAnodexStatus(snapshot(), 'overview'))
    })

    it('picks the soonest enabled task as next up, ignoring paused ones', () => {
      const text = renderAnodexStatus(
        snapshot({
          scheduler: [
            task({ name: 'Later', nextRunAt: NOW + 5 * HOUR }),
            task({ name: 'Paused sooner', nextRunAt: NOW + MINUTE, enabled: false }),
            task({ name: 'Soonest', nextRunAt: NOW + 2 * HOUR })
          ]
        }),
        'overview'
      )
      expect(text).toContain('"Soonest"')
      expect(text).not.toContain('"Paused sooner"')
    })
  })

  describe('scheduler', () => {
    it('lists tasks soonest first with schedule, next run and last result', () => {
      const text = renderAnodexStatus(
        snapshot({
          scheduler: [
            task({ name: 'Later', nextRunAt: NOW + 5 * HOUR }),
            task({ name: 'Sooner', nextRunAt: NOW + HOUR })
          ]
        }),
        'scheduler'
      )
      expect(text.indexOf('Sooner')).toBeLessThan(text.indexOf('Later'))
      expect(text).toContain('Every weekday at 9:00 AM')
      expect(text).toContain('In 1h')
      expect(text).toContain('last run 21h ago (success)')
    })

    it('shows a disabled task as paused rather than counting down', () => {
      const text = renderAnodexStatus(
        snapshot({ scheduler: [task({ enabled: false })] }),
        'scheduler'
      )
      expect(text).toContain('Paused')
      expect(text).not.toContain('In 3h')
    })

    it('says a task has never run instead of printing a missing date', () => {
      const text = renderAnodexStatus(
        snapshot({ scheduler: [task({ lastRunAt: null, lastRunStatus: null })] }),
        'scheduler'
      )
      expect(text).toContain('never run')
    })

    it('answers an empty scheduler with a real answer', () => {
      expect(renderAnodexStatus(snapshot(), 'scheduler')).toContain('No scheduled tasks')
    })

    it('caps a long list and admits what it left out', () => {
      const many = Array.from({ length: 20 }, (_, index) =>
        task({ name: `Task ${index}`, nextRunAt: NOW + index * HOUR })
      )
      const text = renderAnodexStatus(snapshot({ scheduler: many }), 'scheduler')
      expect(text).toContain('20 scheduled tasks')
      expect(text).toContain('…and 12 more not shown.')
      expect(text.split('\n').filter((line) => line.startsWith('- "')).length).toBe(8)
    })
  })

  describe('agents', () => {
    const run = {
      goal: 'Add orbital trails to the simulation',
      status: 'completed',
      turnsUsed: 12,
      maxTurns: 30,
      updatedAt: NOW - 3 * HOUR,
      projectName: 'Universe Sandbox'
    }

    it('reports status, turn use and project, most recent first', () => {
      const text = renderAnodexStatus(
        snapshot({
          agents: [
            { ...run, goal: 'Older', updatedAt: NOW - 2 * DAY },
            { ...run, goal: 'Newer', updatedAt: NOW - HOUR }
          ]
        }),
        'agents'
      )
      expect(text.indexOf('Newer')).toBeLessThan(text.indexOf('Older'))
      expect(text).toContain('12/30 turns')
      expect(text).toContain('in Universe Sandbox')
    })

    it('omits the project clause for a run that has none', () => {
      const text = renderAnodexStatus(
        snapshot({ agents: [{ ...run, projectName: null }] }),
        'agents'
      )
      expect(text).not.toContain(' in ')
    })

    it('answers an empty list with a real answer', () => {
      expect(renderAnodexStatus(snapshot(), 'agents')).toContain('No agent runs yet')
    })
  })

  describe('critical thinking', () => {
    it('reports status and source count', () => {
      const text = renderAnodexStatus(
        snapshot({
          criticalThinking: [
            {
              question: 'Does creatine help endurance athletes?',
              status: 'completed',
              sourceCount: 1,
              updatedAt: NOW - 30 * MINUTE
            }
          ]
        }),
        'critical-thinking'
      )
      expect(text).toContain('completed')
      expect(text).toContain('1 source,')
      expect(text).toContain('30m ago')
    })

    it('answers an empty list with a real answer', () => {
      expect(renderAnodexStatus(snapshot(), 'critical-thinking')).toContain(
        'No Critical Thinking runs yet'
      )
    })
  })

  describe('projects', () => {
    it('marks which project is open', () => {
      const text = renderAnodexStatus(
        snapshot({
          projects: [
            { name: 'Bench', isActive: false },
            { name: 'Universe Sandbox', isActive: true }
          ]
        }),
        'projects'
      )
      expect(text).toContain('- Universe Sandbox (open now)')
      expect(text).toContain('- Bench')
    })

    it('explains what a project is for when there are none', () => {
      expect(renderAnodexStatus(snapshot(), 'projects')).toContain('unlocks file and command tools')
    })
  })

  describe('email', () => {
    it('lists accounts and says it is not reading mail', () => {
      const text = renderAnodexStatus(
        snapshot({
          email: [
            { address: 'me@example.com', provider: 'gmail' },
            { address: 'work@example.com', provider: 'imap' }
          ]
        }),
        'email'
      )
      expect(text).toContain('me@example.com (gmail)')
      expect(text).toContain('does not read mail')
    })

    it('reports no accounts rather than staying silent', () => {
      expect(renderAnodexStatus(snapshot(), 'email')).toContain('No email accounts linked')
    })
  })

  describe('shape of the output', () => {
    it('never renders an empty string for any section', () => {
      // A blank answer is the one a model papers over with an invention.
      const sections: AnodexStatusSection[] = [
        'overview',
        'scheduler',
        'agents',
        'critical-thinking',
        'projects',
        'email'
      ]
      for (const section of sections) {
        expect(renderAnodexStatus(snapshot(), section).trim()).not.toBe('')
      }
    })

    it('keeps a long goal on one line', () => {
      const text = renderAnodexStatus(
        snapshot({
          agents: [
            {
              goal: 'x'.repeat(300),
              status: 'running',
              turnsUsed: 1,
              maxTurns: 5,
              updatedAt: NOW,
              projectName: null
            }
          ]
        }),
        'agents'
      )
      for (const line of text.split('\n')) expect(line.length).toBeLessThan(160)
    })

    it('flattens a multi-line question so it cannot break the list', () => {
      const text = renderAnodexStatus(
        snapshot({
          criticalThinking: [
            {
              question: 'First line\nSecond line',
              status: 'completed',
              sourceCount: 3,
              updatedAt: NOW
            }
          ]
        }),
        'critical-thinking'
      )
      expect(text).toContain('First line Second line')
    })
  })
})
