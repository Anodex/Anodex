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

describe('the gathering guard does not feed itself', () => {
  function streakFrom(message: string): number {
    return Number(/You have made (\d+) information-gathering calls/.exec(message)?.[1] ?? -1)
  }

  function gatherPast(ledger: ReturnType<typeof createTaskLedger>, count: number): void {
    for (let i = 0; i < count; i++) ledger.recordOutcome({ kind: 'read', madeProgress: true })
  }

  // A call the ledger itself refused used to be recorded as a no-op, which
  // incremented the very streak that caused the refusal. Once blocking began it
  // could never stop: each refusal pushed the count higher, so the guard's own
  // output became its evidence. Measured live at 22 and at 10 refusals, on runs
  // that then spent half their turns making calls that could not run.
  it('does not count its own refusals toward the streak', () => {
    const ledger = createTaskLedger()
    gatherPast(ledger, 40)
    const first = ledger.reviewCall({ name: 'read_file', kind: 'read', key: 'a' })
    expect(first.action).toBe('block')
    const before = streakFrom(first.message ?? '')

    // Ten more refusals, recorded the way a blocked call is recorded.
    for (let i = 0; i < 10; i++) {
      ledger.recordOutcome({ kind: 'read', madeProgress: false, refusedByLedger: true })
    }
    const after = ledger.reviewCall({ name: 'read_file', kind: 'read', key: 'b' })

    expect(streakFrom(after.message ?? '')).toBe(before)
  })

  // The guard keeps its teeth: a call that genuinely ran and achieved nothing
  // is still evidence about the model, and still counts.
  it('still counts a real no-op', () => {
    const ledger = createTaskLedger()
    gatherPast(ledger, 40)
    const before = streakFrom(
      ledger.reviewCall({ name: 'r', kind: 'read', key: 'a' }).message ?? ''
    )

    ledger.recordOutcome({ kind: 'read', madeProgress: false })
    const after = ledger.reviewCall({ name: 'r', kind: 'read', key: 'b' })

    expect(streakFrom(after.message ?? '')).toBeGreaterThan(before)
  })
})

describe('an unrecognised command is not evidence of progress', () => {
  function streakFrom(message: string): number {
    return Number(/You have made (\d+) information-gathering calls/.exec(message)?.[1] ?? -1)
  }

  function streakAfter(ledger: ReturnType<typeof createTaskLedger>, key: string): number {
    return streakFrom(ledger.reviewCall({ name: 'read_file', kind: 'read', key }).message ?? '')
  }

  // The measured failure: one run spent about 170 of 208 calls gathering, 82 of
  // them shell scripts like `python -c "open('ui.py').read()"`, and the guard
  // built for "all input, no output" never fired. Every one of those commands
  // was unrecognised, and an unrecognised command counted as progress, so each
  // one bought a free reset of the streak.
  it('does not reset the streak for a command whose effect is unknown', () => {
    const ledger = createTaskLedger()
    for (let i = 0; i < 25; i++) ledger.recordOutcome({ kind: 'read', madeProgress: true })
    const before = streakAfter(ledger, 'a')

    ledger.recordOutcome({ kind: 'command', madeProgress: true, provesChange: false })

    expect(streakAfter(ledger, 'b')).toBe(before)
  })

  // Nor does it count *toward* the guard. This is what kept the bug unfixable:
  // any rule that made an unknown command look like gathering would have made
  // running the test suite push a run toward being blocked.
  it('does not push an unknown command toward the guard either', () => {
    const ledger = createTaskLedger()
    for (let i = 0; i < 25; i++) ledger.recordOutcome({ kind: 'read', madeProgress: true })
    const before = streakAfter(ledger, 'a')

    for (let i = 0; i < 20; i++) {
      ledger.recordOutcome({ kind: 'command', madeProgress: true, provesChange: false })
    }

    expect(streakAfter(ledger, 'b')).toBe(before)
  })

  // A reset drops the streak below the soft limit, at which point the guard
  // says nothing at all - so silence is what a reset looks like from here.
  it('still resets on a command known to change something', () => {
    const ledger = createTaskLedger()
    for (let i = 0; i < 25; i++) ledger.recordOutcome({ kind: 'read', madeProgress: true })
    expect(streakAfter(ledger, 'a')).toBeGreaterThan(0)

    ledger.recordOutcome({ kind: 'command', madeProgress: true, provesChange: true })

    expect(ledger.reviewCall({ name: 'read_file', kind: 'read', key: 'b' }).message).toBeUndefined()
  })

  it('still resets on a real edit', () => {
    const ledger = createTaskLedger()
    for (let i = 0; i < 25; i++) ledger.recordOutcome({ kind: 'read', madeProgress: true })
    expect(streakAfter(ledger, 'a')).toBeGreaterThan(0)

    ledger.recordOutcome({ kind: 'write', madeProgress: true })

    expect(ledger.reviewCall({ name: 'read_file', kind: 'read', key: 'b' }).message).toBeUndefined()
  })
})

describe('a failed edit earns a read back', () => {
  function gatherPast(ledger: ReturnType<typeof createTaskLedger>, count: number): void {
    for (let i = 0; i < count; i++) ledger.recordOutcome({ kind: 'read', madeProgress: true })
  }

  /**
   * Measured: a 4B model at 8,192 wrote a test file with an indentation error
   * and then could not repair it. Its reads were refused — 76 of them — so it
   * edited blind, and every attempt failed with "the text to replace was not
   * found" or "line N does not match expectedFirstLine". Those failures are
   * no-ops, so they never reset the streak, and the run ended reporting it
   * could not read a file that was sitting in the workspace.
   *
   * The guard's premise is that the model already has what it is asking for.
   * These errors are Anodex's own evidence that it does not.
   */
  it('lets a read through after an edit failed on a stale view', () => {
    const ledger = createTaskLedger()
    gatherPast(ledger, 40)
    expect(ledger.reviewCall({ name: 'read_file', kind: 'read', key: 'a' }).action).toBe('block')

    ledger.noteStaleView()

    expect(ledger.reviewCall({ name: 'read_file', kind: 'read', key: 'b' }).action).toBe('run')
  })

  // One read, not an amnesty. A model that keeps failing edits must not be able
  // to hold the guard open indefinitely by failing them.
  it('grants exactly one read per failed edit', () => {
    const ledger = createTaskLedger()
    gatherPast(ledger, 40)
    ledger.noteStaleView()

    expect(ledger.reviewCall({ name: 'read_file', kind: 'read', key: 'b' }).action).toBe('run')
    expect(ledger.reviewCall({ name: 'read_file', kind: 'read', key: 'c' }).action).toBe('block')
  })

  it('does nothing when the guard was not blocking anyway', () => {
    const ledger = createTaskLedger()
    ledger.noteStaleView()

    expect(ledger.reviewCall({ name: 'read_file', kind: 'read', key: 'a' }).action).toBe('run')
  })
})

describe('re-reading after the window was reset', () => {
  function readTwice(ledger: ReturnType<typeof createTaskLedger>, times: number) {
    let last
    for (let i = 0; i < times; i++) {
      last = ledger.reviewCall({
        name: 'read_file_range',
        kind: 'read',
        key: 'read_file_range::test_stats.py 1-200',
        rereadable: true
      })
    }
    return last
  }

  /**
   * Measured on a 4B model at an 8,192-token window: it read `test_stats.py`
   * successfully, the result was evicted within a turn or two, it asked again,
   * and after six identical asks `shouldAbort` refused that read for the rest
   * of the run — 181 refusals. The file was sitting in the workspace.
   *
   * The loop guard cannot tell "stuck in a loop" from "the content is gone and
   * I need it again". A context epoch is exactly the event that tells them
   * apart: it resets the model's history, so a read from before it is no longer
   * anything the model has.
   */
  it('forgives a repeated read once the model has lost the earlier result', () => {
    const ledger = createTaskLedger()
    expect(readTwice(ledger, 8)?.action).toBe('abort')

    ledger.noteContextEpoch()

    expect(readTwice(ledger, 1)?.action).toBe('run')
  })

  // The task's own knowledge survives an epoch - that is the ledger's stated
  // contract, and only the model's *view* was reset.
  it('keeps what the task established across the epoch', () => {
    const ledger = createTaskLedger()
    for (let i = 0; i < 25; i++) ledger.recordOutcome({ kind: 'read', madeProgress: true })
    const before = ledger.reviewCall({ name: 'read_file', kind: 'read', key: 'x' }).message

    ledger.noteContextEpoch()

    expect(ledger.reviewCall({ name: 'read_file', kind: 'read', key: 'y' }).message).toBe(before)
  })

  // Without an epoch nothing changes: a model looping on the same read inside
  // one window is still stuck, and still stopped.
  it('still stops a loop that has not lost anything', () => {
    const ledger = createTaskLedger()

    expect(readTwice(ledger, 8)?.action).toBe('abort')
    expect(readTwice(ledger, 1)?.action).toBe('abort')
  })

  // Forgiveness applies to reads, which are safe to repeat by construction.
  // A mutation repeated identically is not the same question.
  it('does not forgive a repeated write', () => {
    const ledger = createTaskLedger()
    let last
    for (let i = 0; i < 8; i++) {
      last = ledger.reviewCall({ name: 'write_file', kind: 'write', key: 'w::a.py' })
    }
    expect(last?.action).toBe('abort')

    ledger.noteContextEpoch()

    expect(ledger.reviewCall({ name: 'write_file', kind: 'write', key: 'w::a.py' }).action).toBe(
      'abort'
    )
  })
})
