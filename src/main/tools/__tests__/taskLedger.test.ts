import { describe, expect, it } from 'vitest'
import { createTaskLedger } from '../taskLedger'
import { LOOP_GUARD_LIMIT, LOOP_GUARD_ABORT_AFTER } from '../loopGuard'
import { effectiveToolKind } from '../commandEffect'

const BODY = 'const planetData = [\n  { name: "Mercury" },\n  { name: "Venus" }\n]\n'.repeat(6)

function review(
  ledger: ReturnType<typeof createTaskLedger>,
  overrides: Partial<Parameters<ReturnType<typeof createTaskLedger>['reviewCall']>[0]> = {}
): ReturnType<ReturnType<typeof createTaskLedger>['reviewCall']> {
  return ledger.reviewCall({
    name: 'read_file_range',
    kind: 'read',
    key: '{"path":"app.js","startLine":1}',
    args: { path: 'app.js', startLine: 1 },
    rereadable: true,
    ...overrides
  })
}

describe('TaskLedger.reviewCall', () => {
  it('runs a call that is not repeating anything', () => {
    const ledger = createTaskLedger()

    expect(review(ledger).action).toBe('run')
  })

  it('lets a repeated read run again instead of refusing it', () => {
    const ledger = createTaskLedger()

    let verdict = review(ledger)
    for (let i = 0; i < LOOP_GUARD_LIMIT; i++) verdict = review(ledger)

    // The livelock in `docs/CONTEXT_SYSTEM_ROOT_CAUSE.md` §1 was that eviction
    // told the model to re-run a tool the ledger then refused. The first fix
    // pointed it at stored evidence instead; the live runs showed that trades
    // one loop for another, because a recall costs a call *and* permanently
    // enlarges replayed history with a copy that is already stale. Re-reading
    // costs one bounded call and returns what is on disk now.
    expect(verdict.action).toBe('run')
  })

  it('lets a read repeat even with nothing stored, which is why it is safe', () => {
    const ledger = createTaskLedger()

    let verdict = review(ledger)
    for (let i = 0; i < LOOP_GUARD_LIMIT; i++) verdict = review(ledger)

    expect(verdict.action).toBe('run')
  })

  // Allowing the re-read does not remove the backstop, it moves it: a model
  // that has genuinely stuck still stops, just later and by aborting rather
  // than by being handed a stale copy of what it asked for.
  it('still aborts a read that repeats past the abort threshold', () => {
    const ledger = createTaskLedger()

    let verdict = review(ledger)
    for (let i = 0; i < LOOP_GUARD_ABORT_AFTER + 1; i++) verdict = review(ledger)

    expect(verdict.action).toBe('abort')
  })

  it('never gives a non-read the latitude a repeated read gets', () => {
    const ledger = createTaskLedger()
    ledger.evidence.record({ tool: 'run_command', label: 'Run: npm test', body: BODY })

    let verdict = review(ledger, {
      name: 'run_command',
      kind: 'command',
      key: '{"command":"npm test"}',
      args: { command: 'npm test' },
      rereadable: false
    })
    for (let i = 0; i < LOOP_GUARD_LIMIT; i++) {
      verdict = review(ledger, {
        name: 'run_command',
        kind: 'command',
        key: '{"command":"npm test"}',
        args: { command: 'npm test' },
        rereadable: false
      })
    }

    // Re-running a command may be exactly the point, or may be a loop, but it
    // is not the eviction-driven repeat a read gets latitude for.
    expect(verdict.action).toBe('block')
  })

  it('escalates to abort once a block keeps being ignored', () => {
    const ledger = createTaskLedger()

    let verdict = review(ledger)
    for (let i = 0; i < LOOP_GUARD_ABORT_AFTER; i++) verdict = review(ledger)

    expect(verdict.action).toBe('abort')
  })

  it('holds coverage, evidence and repeat state under one lifetime', () => {
    const ledger = createTaskLedger()

    ledger.reads.recordFullFile('/w/app.js')
    ledger.evidence.record({ tool: 'read_file', label: 'Read app.js', body: BODY })

    // The three used to be threaded separately and could disagree about what the
    // task had already done; one object is what makes that impossible.
    expect(ledger.reads.isFullyCovered('/w/app.js')).toBe(true)
    expect(ledger.evidence.index()).toContain('Read app.js')
  })
})

/**
 * The guard nothing had: a turn that gathers and gathers and produces nothing.
 *
 * The loop guard catches an identical call and read coverage catches an
 * identical range, but two live runs on the same request ended 157 calls / 0
 * writes and 103 calls / 0 writes with every individual call legitimately
 * distinct. Counted in settled calls, reset by any durable change.
 */
describe('TaskLedger gathering ladder', () => {
  function gather(ledger: ReturnType<typeof createTaskLedger>, times: number): void {
    for (let i = 0; i < times; i++) {
      ledger.recordOutcome({ kind: 'read', madeProgress: true })
    }
  }

  function look(
    ledger: ReturnType<typeof createTaskLedger>,
    index: number
  ): ReturnType<ReturnType<typeof createTaskLedger>['reviewCall']> {
    // A distinct call every time, so nothing here is caught by the loop guard.
    return ledger.reviewCall({
      name: 'search_files',
      kind: 'read',
      key: `{"pattern":"term-${index}"}`,
      args: { pattern: `term-${index}` }
    })
  }

  it('lets an ordinary investigation run', () => {
    const ledger = createTaskLedger()
    gather(ledger, 10)

    expect(look(ledger, 1).action).toBe('run')
  })

  it('tells a long gathering run to act, without refusing the call', () => {
    const ledger = createTaskLedger()
    gather(ledger, 25)

    const verdict = look(ledger, 1)

    // Still runs: this call may be the one that finally locates the problem.
    expect(verdict.action).toBe('advise')
    expect(verdict.message).toContain('without changing anything')
  })

  it('refuses further gathering once it is clearly going nowhere', () => {
    const ledger = createTaskLedger()
    gather(ledger, 40)

    expect(look(ledger, 1).action).toBe('block')
  })

  it('never blocks a mutation, however long the gathering ran', () => {
    const ledger = createTaskLedger()
    gather(ledger, 60)

    // The whole point is to push the turn toward acting, so the action itself
    // must always get through.
    expect(
      ledger.reviewCall({
        name: 'edit_file',
        kind: 'write',
        key: '{"path":"app.js"}',
        args: { path: 'app.js' }
      }).action
    ).toBe('run')
  })

  it('gives a fresh allowance after real work lands', () => {
    const ledger = createTaskLedger()
    gather(ledger, 40)
    expect(look(ledger, 1).action).toBe('block')

    ledger.recordOutcome({ kind: 'write', madeProgress: true })

    // A task that reads a lot, edits, then investigates the next thing is
    // normal; the streak measures gathering *since the last change*.
    expect(look(ledger, 2).action).toBe('run')
  })

  it('counts no-progress calls toward the streak', () => {
    const ledger = createTaskLedger()
    // This is the shape of the live failure: fifty calls that each succeeded and
    // advanced nothing.
    for (let i = 0; i < 40; i++) ledger.recordOutcome({ kind: 'read', madeProgress: false })

    expect(look(ledger, 1).action).toBe('block')
  })
})

/**
 * The escape hatch a live run found and used twenty-two times.
 *
 * With `run_command` counted as productive work, a turn blocked by the
 * gathering ladder could reset its allowance by fetching the same lines through
 * the shell. The model said so in its own reply: "The system is blocking
 * repeated info calls. Let me use a command to read the file content I need."
 */
describe('the gathering ladder counts shell reads as gathering', () => {
  function shellRead(command: string): { name: string; kind: 'command'; title: string } {
    return { name: 'run_command', kind: 'command', title: `Run: ${command}` }
  }

  it('does not let a shell read reset the streak', () => {
    const ledger = createTaskLedger()
    for (let i = 0; i < 40; i++) ledger.recordOutcome({ kind: 'read', madeProgress: true })

    // What the model actually reached for, in the shapes it actually used.
    for (const command of [
      'sed -n \'40,50p\' "js/app.js"',
      "(Get-Content 'js/app.js') | Select-Object -Index 39,40,41",
      "Select-String -Path 'js/app.js' -Pattern 'ambient'",
      'head -n 100 js/app.js | tail -n 30'
    ]) {
      const kind = effectiveToolKind(shellRead(command), 'read')
      expect(kind).toBe('read')
      ledger.recordOutcome({ kind, madeProgress: true })
    }

    expect(
      ledger.reviewCall({
        name: 'search_files',
        kind: 'read',
        key: '{"pattern":"after-shell"}',
        args: { pattern: 'after-shell' }
      }).action
    ).toBe('block')
  })

  it('still treats a command that changes something as real work', () => {
    const ledger = createTaskLedger()
    for (let i = 0; i < 40; i++) ledger.recordOutcome({ kind: 'read', madeProgress: true })

    const kind = effectiveToolKind(shellRead('npm run build'), 'read')
    expect(kind).toBe('command')
    ledger.recordOutcome({ kind, madeProgress: true })

    expect(
      ledger.reviewCall({
        name: 'search_files',
        kind: 'read',
        key: '{"pattern":"after-build"}',
        args: { pattern: 'after-build' }
      }).action
    ).toBe('run')
  })
})
