import { describe, expect, it } from 'vitest'
import {
  LOOP_GUARD_LIMIT,
  checkLoopGuard,
  createLoopGuardState,
  loopGuardMessage
} from '../loopGuard'

describe('checkLoopGuard', () => {
  it('allows the first calls through, up to the limit', () => {
    const state = createLoopGuardState()
    for (let i = 1; i <= LOOP_GUARD_LIMIT; i++) {
      const result = checkLoopGuard(state, 'find_skill', 'Find skill "foo"')
      expect(result.blocked).toBe(false)
      expect(result.count).toBe(i)
    }
  })

  it('blocks once the same name+title repeats past the limit', () => {
    const state = createLoopGuardState()
    for (let i = 1; i <= LOOP_GUARD_LIMIT; i++) {
      checkLoopGuard(state, 'find_skill', 'Find skill "foo"')
    }
    const result = checkLoopGuard(state, 'find_skill', 'Find skill "foo"')
    expect(result.blocked).toBe(true)
    expect(result.count).toBe(LOOP_GUARD_LIMIT + 1)
  })

  it('keeps blocking on further repeats, not just the first one past the limit', () => {
    const state = createLoopGuardState()
    for (let i = 0; i < LOOP_GUARD_LIMIT + 5; i++) {
      checkLoopGuard(state, 'find_skill', 'Find skill "foo"')
    }
    const result = checkLoopGuard(state, 'find_skill', 'Find skill "foo"')
    expect(result.blocked).toBe(true)
    expect(result.count).toBe(LOOP_GUARD_LIMIT + 6)
  })

  it('tracks different titles for the same tool independently', () => {
    const state = createLoopGuardState()
    for (let i = 0; i < LOOP_GUARD_LIMIT + 2; i++) {
      checkLoopGuard(state, 'find_skill', 'Find skill "foo"')
    }
    const result = checkLoopGuard(state, 'find_skill', 'Find skill "bar"')
    expect(result.blocked).toBe(false)
    expect(result.count).toBe(1)
  })

  it('tracks different tool names with the same title independently', () => {
    const state = createLoopGuardState()
    for (let i = 0; i < LOOP_GUARD_LIMIT + 2; i++) {
      checkLoopGuard(state, 'find_skill', 'same title')
    }
    const result = checkLoopGuard(state, 'load_skill', 'same title')
    expect(result.blocked).toBe(false)
    expect(result.count).toBe(1)
  })
})

describe('loopGuardMessage', () => {
  it('names the tool and the repeat count', () => {
    const message = loopGuardMessage('find_skill', 4)
    expect(message).toContain('find_skill')
    expect(message).toContain('4 times')
  })
})
