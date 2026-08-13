import { describe, expect, it } from 'vitest'
import {
  LOOP_GUARD_ABORT_AFTER,
  LOOP_GUARD_LIMIT,
  checkLoopGuard,
  createLoopGuardState,
  loopGuardKey,
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

  it('does not ask to abort while only blocked, below the abort threshold', () => {
    const state = createLoopGuardState()
    for (let i = 1; i < LOOP_GUARD_ABORT_AFTER; i++) {
      const result = checkLoopGuard(state, 'load_skill', 'Load skill "x"')
      expect(result.shouldAbort).toBe(false)
    }
  })

  it('asks to abort once the same call reaches the abort threshold, and keeps asking after', () => {
    const state = createLoopGuardState()
    for (let i = 1; i < LOOP_GUARD_ABORT_AFTER; i++) {
      checkLoopGuard(state, 'load_skill', 'Load skill "x"')
    }
    const atThreshold = checkLoopGuard(state, 'load_skill', 'Load skill "x"')
    expect(atThreshold.count).toBe(LOOP_GUARD_ABORT_AFTER)
    expect(atThreshold.shouldAbort).toBe(true)

    const pastThreshold = checkLoopGuard(state, 'load_skill', 'Load skill "x"')
    expect(pastThreshold.shouldAbort).toBe(true)
  })

  it('only counts consecutive repeats — a different call in between resets the streak', () => {
    const state = createLoopGuardState()
    for (let i = 0; i < LOOP_GUARD_LIMIT; i++) {
      checkLoopGuard(state, 'run_command', 'npm test')
    }
    // A distinct call in between — e.g. a real edit — resets the streak, so
    // the model can legitimately keep re-running the same command after
    // each fix without ever tripping the guard.
    checkLoopGuard(state, 'write_file', '{"path":"a.ts"}')
    const result = checkLoopGuard(state, 'run_command', 'npm test')
    expect(result.blocked).toBe(false)
    expect(result.count).toBe(1)
  })

  it('still blocks truly consecutive repeats with nothing in between', () => {
    const state = createLoopGuardState()
    for (let i = 0; i < LOOP_GUARD_LIMIT; i++) {
      checkLoopGuard(state, 'run_command', 'npm test')
    }
    const result = checkLoopGuard(state, 'run_command', 'npm test')
    expect(result.blocked).toBe(true)
  })

  it('blocks an alternating A-B-A-B cycle that makes no progress', () => {
    const state = createLoopGuardState()
    let result = checkLoopGuard(state, 'read_file', 'a.ts')
    for (let i = 0; i <= LOOP_GUARD_LIMIT; i++) {
      checkLoopGuard(state, 'read_file', 'b.ts')
      result = checkLoopGuard(state, 'read_file', 'a.ts')
    }
    expect(result.blocked).toBe(true)
  })

  it('blocks an identical stable read repeated between unrelated stable reads', () => {
    const state = createLoopGuardState()
    let repeated: ReturnType<typeof checkLoopGuard> | undefined
    for (let i = 0; i < 4; i++) {
      repeated = checkLoopGuard(state, 'read_file_range', 'service.ts:1-200')
      checkLoopGuard(state, 'read_file_range', `other-${i}.ts:1-200`)
    }
    expect(repeated?.blocked).toBe(true)
  })

  it('resets interleaved stable-read counts after a potentially changing action', () => {
    const state = createLoopGuardState()
    for (let i = 0; i < 3; i++) {
      checkLoopGuard(state, 'read_file', 'status.json')
      checkLoopGuard(state, 'read_file', `other-${i}.json`)
    }
    checkLoopGuard(state, 'write_file', 'status.json:new-content')
    const afterWrite = checkLoopGuard(state, 'read_file', 'status.json')
    expect(afterWrite.blocked).toBe(false)
    expect(afterWrite.count).toBe(1)
  })
})

describe('loopGuardKey', () => {
  it('produces the same key for arguments in a different order', () => {
    const a = loopGuardKey({ args: { path: 'a.ts', content: 'x' }, title: 'irrelevant' })
    const b = loopGuardKey({ args: { content: 'x', path: 'a.ts' }, title: 'irrelevant' })
    expect(a).toBe(b)
  })

  it('produces different keys when the actual arguments differ, even with the same title', () => {
    const a = loopGuardKey({ args: { path: 'a.ts', content: 'one' }, title: 'Write a.ts' })
    const b = loopGuardKey({ args: { path: 'a.ts', content: 'two' }, title: 'Write a.ts' })
    expect(a).not.toBe(b)
  })

  it('falls back to title when args is not provided', () => {
    expect(loopGuardKey({ title: 'List changes' })).toBe('List changes')
  })

  it('falls back to title, not args, only when args is genuinely absent — an empty object still counts', () => {
    const withEmptyArgs = loopGuardKey({ args: {}, title: 'Some title' })
    const withoutArgs = loopGuardKey({ title: 'Some title' })
    expect(withEmptyArgs).not.toBe(withoutArgs)
  })
})

describe('checkLoopGuard combined with loopGuardKey — the concrete scenario both reviews flagged', () => {
  it('does not block four different edits to the same file in a row', () => {
    const state = createLoopGuardState()
    const edits = ['one', 'two', 'three', 'four']
    for (const content of edits) {
      const key = loopGuardKey({ args: { path: 'foo.ts', content }, title: 'Write foo.ts' })
      const result = checkLoopGuard(state, 'write_file', key)
      expect(result.blocked).toBe(false)
    }
  })

  it('does block four identical edits (same path, same content) in a row', () => {
    const state = createLoopGuardState()
    let last: ReturnType<typeof checkLoopGuard> | undefined
    for (let i = 0; i < 4; i++) {
      const key = loopGuardKey({
        args: { path: 'foo.ts', content: 'same' },
        title: 'Write foo.ts'
      })
      last = checkLoopGuard(state, 'write_file', key)
    }
    expect(last?.blocked).toBe(true)
  })
})

describe('loopGuardMessage', () => {
  it('names the tool and the repeat count', () => {
    const message = loopGuardMessage('find_skill', 4, false)
    expect(message).toContain('find_skill')
    expect(message).toContain('4 times')
  })

  it('mentions that generation is stopping, only when aborting', () => {
    const blockedOnly = loopGuardMessage('find_skill', 4, false)
    expect(blockedOnly.toLowerCase()).not.toContain('stopped')

    const aborting = loopGuardMessage('find_skill', 6, true)
    expect(aborting.toLowerCase()).toContain('stopped')
  })
})

/**
 * Replays the exact search sequence from chat
 * `c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef`, where the model asked for one
 * symbol five different ways. Every one produced a distinct exact fingerprint,
 * so the guard never fired and five tool calls bought nothing.
 */
describe('paraphrased query loops', () => {
  const INCIDENT_QUERIES = [
    'updateClickRipples function definition',
    'updateClickRipples function definition in universe-sandbox',
    'updateClickRipples function definition',
    'updateClickRipples function definition in universe sandbox',
    'function updateClickRipples definition'
  ]

  it('blocks the rephrased search the exact fingerprint missed', () => {
    const state = createLoopGuardState()

    const results = INCIDENT_QUERIES.map((query) =>
      checkLoopGuard(state, 'search_code', JSON.stringify({ query }), { query })
    )

    expect(results.slice(0, 3).every((result) => !result.blocked)).toBe(true)
    expect(results[3].blocked).toBe(true)
    expect(results[4].blocked).toBe(true)
  })

  it('does not force-abort on paraphrase evidence alone', () => {
    const state = createLoopGuardState()

    const results = INCIDENT_QUERIES.map((query) =>
      checkLoopGuard(state, 'search_code', JSON.stringify({ query }), { query })
    )

    expect(results.every((result) => !result.shouldAbort)).toBe(true)
  })

  it('keeps genuinely different searches distinct', () => {
    const state = createLoopGuardState()

    const queries = [
      'three module import failure',
      'webgl context creation',
      'canvas layout dimensions',
      'orbit controls damping'
    ]
    const results = queries.map((query) =>
      checkLoopGuard(state, 'search_code', JSON.stringify({ query }), { query })
    )

    expect(results.every((result) => !result.blocked)).toBe(true)
  })

  it('starts a fresh window after a mutation, since results can change', () => {
    const state = createLoopGuardState()
    const query = 'updateClickRipples definition'

    for (let attempt = 0; attempt < 3; attempt++) {
      checkLoopGuard(state, 'search_code', JSON.stringify({ query, attempt }), { query })
    }
    checkLoopGuard(state, 'edit_file', JSON.stringify({ path: 'a.js' }), { path: 'a.js' })
    const afterEdit = checkLoopGuard(state, 'search_code', JSON.stringify({ query, n: 9 }), {
      query
    })

    expect(afterEdit.blocked).toBe(false)
  })

  it('ignores calls with no query argument', () => {
    const state = createLoopGuardState()

    const result = checkLoopGuard(state, 'read_file', JSON.stringify({ path: 'a.ts' }), {
      path: 'a.ts'
    })

    expect(result.count).toBe(1)
  })
})
