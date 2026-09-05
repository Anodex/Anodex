import { describe, expect, it } from 'vitest'
import {
  CONTEXT_EPOCH_LIMIT,
  contextRecoveryExhaustedReason,
  finishedWithNothingToShow,
  IDLE_TURN_LIMIT,
  idleRunReason,
  noPlanReason,
  REFUSED_TURN_LIMIT,
  refusedRunReason
} from '../agentRunProgress'

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

  it('names a context limit when that is what cut the turns short', () => {
    // Measured on bench-1, qwen27b at 8,192 (2026-09-05). Seven turns were
    // ended by the runtime with "no room left for a usable reply" -- fixed
    // input 6,574 tokens against a 7,680 limit with 1,280 reserved for the
    // reply. The run then reported that the model "was still replying" and
    // that "nothing here says why it stopped calling tools".
    //
    // Both halves were wrong. The model was not still replying; its turns were
    // aborted before it could act. And the reason was recorded on every one of
    // those turns as a stop reason. Reporting a context limit as a model that
    // gave up sends the reader to change models when they need a larger window
    // or fewer bound tools.
    const reason = idleRunReason(IDLE_TURN_LIMIT, [
      'context-limit',
      'context-limit',
      'context-limit'
    ])

    expect(reason).toMatch(/context/i)
    expect(reason).not.toContain('still replying')
    expect(reason).not.toMatch(/nothing here says why/i)
  })

  it('names it for a fixed-context limit too', () => {
    const reason = idleRunReason(IDLE_TURN_LIMIT, [
      'fixed-context-limit',
      'fixed-context-limit',
      'fixed-context-limit'
    ])

    expect(reason).toMatch(/context/i)
  })

  it('keeps the honest wording when the turns stopped for mixed or unknown reasons', () => {
    // One context-limited turn among three does not make the run a context
    // problem, and guessing from the majority would be guessing in the user's
    // name. The original reasoning stands wherever the record does not agree
    // with itself.
    const mixed = idleRunReason(IDLE_TURN_LIMIT, ['context-limit', undefined, 'token-limit']) ?? ''

    expect(mixed).toContain('without making a single tool call')
    expect(mixed).not.toMatch(/no room/i)
    expect(idleRunReason(IDLE_TURN_LIMIT, []) ?? '').toContain('without making a single tool call')
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

describe('refusedRunReason', () => {
  // Measured on bench-1 with a 4B at 8,192: the run made its last successful
  // call at turn 19 and then spent 181 consecutive turns in which every call
  // was refused - the loop guard answering "you've already called
  // read_file_range with identical effective arguments" 181 times. It hit its
  // 200-turn cap having spent 5% of its tokens.
  //
  // `idleRunReason` does not see this: those turns DO make tool calls, they are
  // simply all refused.
  it('stops a run whose every call has been refused for several turns', () => {
    expect(refusedRunReason(REFUSED_TURN_LIMIT)).not.toBeNull()
    expect(refusedRunReason(REFUSED_TURN_LIMIT)).toContain('refused')
  })

  it('says nothing before the limit', () => {
    expect(refusedRunReason(REFUSED_TURN_LIMIT - 1)).toBeNull()
    expect(refusedRunReason(0)).toBeNull()
  })

  // A model that hits a guard once or twice and then varies its call is working
  // normally, so the limit has to be above that.
  it('tolerates a couple of refused turns', () => {
    expect(REFUSED_TURN_LIMIT).toBeGreaterThan(2)
  })

  it('states what was seen without naming a cause it cannot know', () => {
    const reason = refusedRunReason(REFUSED_TURN_LIMIT) ?? ''

    expect(reason).toContain(String(REFUSED_TURN_LIMIT))
    expect(reason.toLowerCase()).not.toContain('context window')
  })
})

describe('noPlanReason', () => {
  /**
   * Measured on a 13B roleplay merge at 4,096 tokens: the run ended `error`
   * after two turns and 399 tokens with "Could not produce a plan for review."
   * Anodex behaved well — it tried, retried, and stopped cheaply rather than
   * grinding thirty turns against a model that could not do the job. But the
   * message named the symptom and left the user to guess the cause.
   */
  it('says what was actually seen', () => {
    const reason = noPlanReason(2)

    expect(reason).toContain('twice')
    expect(reason.toLowerCase()).toContain('plan')
  })

  it('points at the likeliest cause without asserting it', () => {
    const reason = noPlanReason(2).toLowerCase()

    // The honest shape: name what a plan needs, and let the reader connect it
    // to their model. Anodex cannot know why a given model failed.
    expect(reason).toMatch(/tool|function/)
    expect(reason).not.toMatch(/your model is|the model cannot|because the model/)
  })

  it('reads correctly after a single attempt', () => {
    expect(noPlanReason(1)).toContain('once')
    expect(noPlanReason(1)).not.toContain('twice')
  })
})

describe('contextRecoveryExhaustedReason', () => {
  // An aborted turn is not a wasted one: the runtime ended it before the model
  // could act, and the run answers by dropping history the handoff now states.
  // That deserves more attempts than a model that has stopped calling tools,
  // which is why this limit sits above IDLE_TURN_LIMIT.
  it('gives recovery more rope than an idle model', () => {
    expect(CONTEXT_EPOCH_LIMIT).toBeGreaterThan(IDLE_TURN_LIMIT)
  })

  it('says nothing while recovery still has attempts left', () => {
    expect(contextRecoveryExhaustedReason(0)).toBeNull()
    expect(contextRecoveryExhaustedReason(CONTEXT_EPOCH_LIMIT - 1)).toBeNull()
  })

  it('stops the run when even a stripped-back prompt will not fit', () => {
    const reason = contextRecoveryExhaustedReason(CONTEXT_EPOCH_LIMIT) ?? ''

    expect(reason).toMatch(/context/i)
    // Actionable, and honest about what was already tried.
    expect(reason).toMatch(/dropped the earlier history/i)
    expect(reason).toMatch(/larger context window|fewer tools/i)
  })
})
