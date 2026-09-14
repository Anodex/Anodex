import { describe, expect, it } from 'vitest'
import type { ChatWorkingEvent } from '@shared/chat.types'
import { startWorkingHeartbeat } from '../workingHeartbeat'

/** A clock and an interval that only move when the test says so. */
function harness(waiting: { value: boolean }) {
  let time = 1_000
  let tick: (() => void) | null = null
  const sent: ChatWorkingEvent[] = []
  const beat = startWorkingHeartbeat({
    conversationId: 'c1',
    messageId: 'm1',
    send: (event) => sent.push(event),
    waitingForModel: () => waiting.value,
    intervalMs: 30_000,
    now: () => time,
    setInterval: (callback) => {
      tick = callback
      return 1
    },
    clearInterval: () => {
      tick = null
    }
  })
  return {
    beat,
    sent,
    advance: (ms: number): void => {
      time += ms
      tick?.()
    }
  }
}

describe('startWorkingHeartbeat', () => {
  it('says "waiting" at once when the turn arrives to find the model busy', () => {
    // The case from the phone: a question queued behind an agent run's turn.
    const { sent } = harness({ value: true })
    expect(sent).toEqual([
      { conversationId: 'c1', messageId: 'm1', phase: 'waiting-for-model', since: 1_000 }
    ])
  })

  it('says nothing at the start when the model is free', () => {
    expect(harness({ value: false }).sent).toEqual([])
  })

  it('keeps saying so every half minute while nothing else is sent', () => {
    const waiting = { value: true }
    const { sent, advance } = harness(waiting)
    advance(30_000)
    advance(30_000)
    expect(sent.map((event) => event.phase)).toEqual([
      'waiting-for-model',
      'waiting-for-model',
      'waiting-for-model'
    ])
  })

  it('reports working once the turn has produced anything, even if something else queues', () => {
    const waiting = { value: true }
    const { beat, sent, advance } = harness(waiting)
    beat.touch()
    advance(30_000)
    expect(sent.at(-1)?.phase).toBe('working')
  })

  it('stays quiet while tokens are flowing', () => {
    const { beat, sent, advance } = harness({ value: false })
    advance(20_000)
    beat.touch()
    advance(20_000)
    beat.touch()
    advance(20_000)
    expect(sent).toEqual([])
  })

  it('keeps its schedule through thinking a phone was not sent, but no longer says waiting', () => {
    // A phone that has not opened the thinking hears nothing while a model thinks
    // for a minute, and gives up on a turn after five minutes of silence.
    const waiting = { value: true }
    const { beat, sent, advance } = harness(waiting)
    sent.length = 0
    advance(20_000)
    beat.touch(false)
    advance(10_000)
    expect(sent.map((event) => event.phase)).toEqual(['working'])
  })

  it('sends nothing after it is stopped', () => {
    const { beat, sent, advance } = harness({ value: false })
    beat.stop()
    advance(60_000)
    expect(sent).toEqual([])
  })

  it('sends reading progress at once, and a later quiet stretch no longer says waiting', () => {
    const waiting = { value: true }
    const { beat, sent, advance } = harness(waiting)
    sent.length = 0

    beat.reading({ done: 2_048, total: 9_840 })
    expect(sent).toEqual([
      {
        conversationId: 'c1',
        messageId: 'm1',
        phase: 'reading',
        since: 1_000,
        reading: { done: 2_048, total: 9_840 }
      }
    ])

    advance(30_000)
    expect(sent.at(-1)?.phase).toBe('working')
  })

  it('sends nothing once stopped', () => {
    const { beat, sent } = harness({ value: false })
    beat.stop()
    beat.reading({ done: 1, total: 2 })
    expect(sent).toEqual([])
  })
})
