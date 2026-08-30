import { describe, expect, it } from 'vitest'
import { finishedWithNothingToShow, IDLE_TURN_LIMIT, idleRunReason } from '../agentRunProgress'

describe('finishedWithNothingToShow', () => {
  function plan(...statuses: string[]) {
    return {
      steps: statuses.map((status, index) => ({ id: `s${index}`, title: `step ${index}`, status }))
    } as never
  }

  // The measured run: `finish_goal` accepted, six plan steps open, not one
  // write, edit or patch call all run, and a summary saying the work "has been
  // successfully implemented and verified". Recorded as `done`, unflagged.
  it('flags a finish with open plan steps and no durable change', () => {
    expect(finishedWithNothingToShow({ durableChanges: 0, plan: plan('pending', 'pending') })).toBe(
      true
    )
  })

  it('says nothing when the run actually changed something', () => {
    expect(finishedWithNothingToShow({ durableChanges: 1, plan: plan('pending', 'pending') })).toBe(
      false
    )
  })

  // A run that finished its plan and wrote nothing is a legitimate outcome -
  // "explain this code", "is X safe to remove". The flag must not fire there,
  // or it becomes noise on exactly the runs that behaved.
  it('says nothing when every step was completed', () => {
    expect(
      finishedWithNothingToShow({ durableChanges: 0, plan: plan('completed', 'completed') })
    ).toBe(false)
  })

  it('says nothing for a run with no plan at all', () => {
    expect(finishedWithNothingToShow({ durableChanges: 0, plan: null })).toBe(false)
  })
})

describe('idleRunReason', () => {
  // Measured twice, on models three sizes apart. A 4B run spent turns 22-30 -
  // nine consecutive turns - producing no tool calls at all and then hit its
  // turn cap. DeepSeek-R1-Distill-32B did the same for six turns, emitting
  // byte-identical replies. Nothing watched for it, so both runs burned their
  // remaining budget and reported only that they ran out of turns.
  it('stops a run after enough consecutive turns that did nothing', () => {
    expect(idleRunReason(IDLE_TURN_LIMIT)).not.toBeNull()
    expect(idleRunReason(IDLE_TURN_LIMIT)).toContain('without making a single tool call')
  })

  it('says nothing before the limit', () => {
    expect(idleRunReason(IDLE_TURN_LIMIT - 1)).toBeNull()
    expect(idleRunReason(0)).toBeNull()
  })

  // A turn that thinks and then acts is normal, so the count has to be
  // consecutive and the limit above one - otherwise this ends runs that were
  // about to do something.
  it('allows a turn or two of silence', () => {
    expect(IDLE_TURN_LIMIT).toBeGreaterThan(2)
  })

  // The reason is what the user reads, so it must say what happened and what
  // to do, not just that something stopped.
  it('says what was seen rather than naming a cause it cannot know', () => {
    const reason = idleRunReason(IDLE_TURN_LIMIT) ?? ''

    expect(reason).toContain(String(IDLE_TURN_LIMIT))
    expect(reason.toLowerCase()).not.toContain('context window')
  })
})
