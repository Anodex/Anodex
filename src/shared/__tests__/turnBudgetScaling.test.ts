import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BUILD_MAX_DURATION_MINUTES,
  DEFAULT_BUILD_MAX_TOKENS,
  DEFAULT_BUILD_MAX_TURNS,
  DEFAULT_MAX_DURATION_MINUTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_TURNS,
  MAX_MAX_DURATION_MINUTES,
  MAX_MAX_TOKENS,
  MAX_MAX_TURNS,
  TURN_BUDGET_REFERENCE_CONTEXT,
  defaultMaxTurnsFor,
  defaultRunBudgets,
  maxTurnsCeilingFor
} from '../agentRun.types'
import { buildRunToolNames, readOnlyRunToolNames, toolsCanChangeFiles } from '../tools.types'

describe('turn budgets scale with the window a turn actually has', () => {
  // The reference pair is the one the existing constants were chosen against,
  // so at that window nothing whatsoever changes.
  it('is unchanged at the context the constants were sized for', () => {
    expect(maxTurnsCeilingFor(TURN_BUDGET_REFERENCE_CONTEXT)).toBe(MAX_MAX_TURNS)
    expect(defaultMaxTurnsFor(TURN_BUDGET_REFERENCE_CONTEXT)).toBe(DEFAULT_MAX_TURNS)
  })

  // The measured failure: a turn at 8,192 does a fraction of the work a turn at
  // 65,536 does, so 60 turns there is a small fraction of the same run - and 60
  // was the most the app would even accept.
  it('allows far more turns on a small window', () => {
    expect(maxTurnsCeilingFor(8192)).toBeGreaterThan(MAX_MAX_TURNS * 5)
    expect(defaultMaxTurnsFor(8192)).toBeGreaterThan(DEFAULT_MAX_TURNS * 5)
  })

  it('scales monotonically - a smaller window never gets fewer turns', () => {
    const sizes = [4096, 8192, 16384, 32768, 65536, 131072, 200000]
    const ceilings = sizes.map(maxTurnsCeilingFor)
    for (let i = 1; i < ceilings.length; i++) {
      expect(ceilings[i]).toBeLessThanOrEqual(ceilings[i - 1])
    }
  })

  // Raising a limit removes one; lowering it adds one. A large window must
  // never end up able to ask for fewer turns than it can today.
  it.each([65536, 131072, 200000, 1_000_000])('never lowers the limit at %i', (size) => {
    expect(maxTurnsCeilingFor(size)).toBeGreaterThanOrEqual(MAX_MAX_TURNS)
    expect(defaultMaxTurnsFor(size)).toBeGreaterThanOrEqual(DEFAULT_MAX_TURNS)
  })

  it('falls back to the fixed constants when the window is unknown', () => {
    expect(maxTurnsCeilingFor(undefined)).toBe(MAX_MAX_TURNS)
    expect(defaultMaxTurnsFor(undefined)).toBe(DEFAULT_MAX_TURNS)
    expect(maxTurnsCeilingFor(0)).toBe(MAX_MAX_TURNS)
  })

  it('stays a whole number of turns', () => {
    for (const size of [4096, 8192, 12000, 16384, 65536]) {
      expect(Number.isInteger(maxTurnsCeilingFor(size))).toBe(true)
      expect(Number.isInteger(defaultMaxTurnsFor(size))).toBe(true)
    }
  })
})

describe('what a new run starts with', () => {
  // Measured: a website build finished in 14 turns, 85k tokens and 58 minutes, and a
  // second one stopped at 8 of 8 turns having only read the files it meant to change.
  it('gives a run that can change files room to finish a build', () => {
    const build = defaultRunBudgets(true, TURN_BUDGET_REFERENCE_CONTEXT)
    expect(build).toEqual({
      maxTurns: DEFAULT_BUILD_MAX_TURNS,
      maxTokens: DEFAULT_BUILD_MAX_TOKENS,
      maxDurationMinutes: DEFAULT_BUILD_MAX_DURATION_MINUTES
    })
    expect(build.maxTurns).toBeGreaterThanOrEqual(28)
    expect(build.maxTokens).toBeGreaterThanOrEqual(170_000)
    expect(build.maxDurationMinutes).toBeGreaterThanOrEqual(116)
  })

  it('keeps a look-only run to the small budget', () => {
    expect(defaultRunBudgets(false, TURN_BUDGET_REFERENCE_CONTEXT)).toEqual({
      maxTurns: DEFAULT_MAX_TURNS,
      maxTokens: DEFAULT_MAX_TOKENS,
      maxDurationMinutes: DEFAULT_MAX_DURATION_MINUTES
    })
  })

  it('stays within what a run may be configured with, on any window', () => {
    for (const size of [4096, 8192, 65536, 200000]) {
      const build = defaultRunBudgets(true, size)
      expect(build.maxTurns).toBeLessThanOrEqual(maxTurnsCeilingFor(size))
      expect(build.maxTokens).toBeLessThanOrEqual(MAX_MAX_TOKENS)
      expect(build.maxDurationMinutes).toBeLessThanOrEqual(MAX_MAX_DURATION_MINUTES)
    }
  })

  it('tells a run that can change files from one that only looks', () => {
    expect(toolsCanChangeFiles(buildRunToolNames())).toBe(true)
    expect(toolsCanChangeFiles(readOnlyRunToolNames())).toBe(false)
    expect(toolsCanChangeFiles([])).toBe(false)
    expect(toolsCanChangeFiles(['no_such_tool'])).toBe(false)
  })
})
