import type { Plan } from '@shared/plan.types'
import type { ToolCall } from '@shared/tools.types'
import { describe, expect, it } from 'vitest'
import type { PathClaimIssue } from '../../tools/pathClaimVerification'
import { describeTurnOutcome, isDurableChange, isVerificationCommand } from '../turnSummary'

function call(overrides: Partial<ToolCall> & Pick<ToolCall, 'name' | 'kind'>): ToolCall {
  return {
    id: `call-${Math.random().toString(36).slice(2)}`,
    title: overrides.name,
    status: 'success',
    ...overrides
  }
}

const wrote = (path: string): ToolCall =>
  call({ name: 'write_file', kind: 'write', title: `Write ${path}`, touchedPaths: [path] })

const read = (path: string): ToolCall =>
  call({ name: 'read_file_range', kind: 'read', title: `Read ${path}`, touchedPaths: [path] })

const ran = (command: string, exit = 0): ToolCall =>
  call({ name: 'run_command', kind: 'command', title: `Run: ${command}`, detail: `exit ${exit}` })

function summary(overrides: Partial<Parameters<typeof describeTurnOutcome>[0]> = {}): string {
  return (
    describeTurnOutcome({
      calls: [],
      plan: null,
      stopped: false,
      blockedGathering: 0,
      unverifiedPaths: [],
      ...overrides
    }) ?? ''
  )
}

describe('isVerificationCommand', () => {
  /**
   * The false accusation this guards, measured live: a turn ran
   * `python _smoke_test.py` to a green exit three times and was still told
   * "**Not verified** — no build, test, type-check or lint command ran". A
   * project with no test framework verifies itself by running its own script,
   * and for many small projects that is the only check there is.
   */
  it('counts an interpreter running one of the project’s scripts', () => {
    expect(isVerificationCommand('cd Sandbox/UniverseSandbox; python _smoke_test.py')).toBe(true)
    expect(isVerificationCommand('cd app && python -u run_checks.py')).toBe(true)
    expect(isVerificationCommand('node check.mjs')).toBe(true)
    expect(isVerificationCommand('ruby spec_runner.rb')).toBe(true)
  })

  /**
   * The opposite error, and the worse one for an honesty feature: `python -c`
   * is how a model *reads* things — the same live turn used it to count lines
   * in a file — so treating it as proof would turn a missing note into a false
   * claim that the change was checked.
   */
  it('does not count an inline snippet as having checked anything', () => {
    expect(
      isVerificationCommand(`python -c "lines=open('ui.py').readlines(); print(len(lines))"`)
    ).toBe(false)
    expect(isVerificationCommand('python -c "print(1)"')).toBe(false)
  })

  it('still counts the named build and test tools', () => {
    expect(isVerificationCommand('npm test')).toBe(true)
    expect(isVerificationCommand('cargo test')).toBe(true)
    expect(isVerificationCommand('pytest -q')).toBe(true)
    expect(isVerificationCommand('g++ -o main main.cpp')).toBe(true)
  })

  it('does not count ordinary inspection', () => {
    expect(isVerificationCommand('ls -la')).toBe(false)
    expect(isVerificationCommand('cat main.py')).toBe(false)
    expect(isVerificationCommand('git status')).toBe(false)
  })
})

describe('describeTurnOutcome', () => {
  it('says nothing for an ordinary conversational reply', () => {
    expect(
      describeTurnOutcome({
        calls: [],
        plan: null,
        stopped: false,
        blockedGathering: 0,
        unverifiedPaths: []
      })
    ).toBeNull()
  })

  describe('what it changed', () => {
    it('names the files it wrote, and counts repeat edits to one file', () => {
      const text = summary({ calls: [wrote('src/a.ts'), wrote('src/a.ts'), wrote('src/b.ts')] })
      expect(text).toContain('`src/a.ts` (2 edits)')
      expect(text).toContain('`src/b.ts`')
    })

    it('says so plainly when a reply only looked', () => {
      expect(summary({ calls: [read('src/a.ts')] })).toContain('**Changed** nothing')
    })

    // `run_command`'s kind describes the tool, not the effect: `cat` is a read.
    it('does not count a shell command that only inspected a file', () => {
      const text = summary({ calls: [ran('cat src/a.ts')] })
      expect(text).toContain('**Changed** nothing')
    })
  })

  describe('what it verified', () => {
    it('names the command that verified the change', () => {
      const text = summary({ calls: [wrote('src/a.ts'), ran('npm run build')] })
      expect(text).toContain('**Verified** `npm run build` passed')
      expect(text).not.toContain('Not verified')
    })

    // A failing build is the most useful thing a turn can report; it must never
    // hide inside a line that opens with the word "Verified".
    it('reports a verification that ran and failed as a failure', () => {
      const text = summary({ calls: [wrote('src/a.ts'), ran('npm test', 1)] })
      expect(text).toContain('**Ran** `npm test` failed')
      expect(text).not.toContain('**Verified**')
    })

    it('reports the last outcome when a fix turned a failing build green', () => {
      const text = summary({ calls: [ran('npm test', 1), wrote('src/a.ts'), ran('npm test', 0)] })
      expect(text).toContain('**Verified** `npm test` passed')
      expect(text).not.toContain('failed')
    })

    it('flags a change nothing was run against', () => {
      expect(summary({ calls: [wrote('src/a.ts')] })).toContain('**Not verified**')
    })

    // A static site has no build command. Calling a screenshotted fix
    // "unverified" is the same false accusation as calling a green cargo test
    // unverified, and it lands only on the projects with nothing to run.
    it('counts a screenshot taken after the last change as verification', () => {
      const text = summary({
        calls: [wrote('index.html'), call({ name: 'inspect_visual', kind: 'read' })]
      })
      expect(text).toContain('**Verified** visually')
      expect(text).not.toContain('Not verified')
    })

    it('does not count a screenshot taken before the change', () => {
      const text = summary({
        calls: [call({ name: 'inspect_visual', kind: 'read' }), wrote('index.html')]
      })
      expect(text).toContain('**Not verified**')
    })

    it('stays quiet about verification when nothing was changed', () => {
      expect(summary({ calls: [read('src/a.ts')] })).not.toContain('Not verified')
    })

    // Anodex is pointed at any workspace; a green `cargo test` is a real
    // verification, and calling it unverified would be a false accusation.
    it.each(['cargo test', 'pytest', 'go build ./...', 'make check', 'mvn verify', 'rspec'])(
      'recognises %s as verification',
      (command) => {
        expect(summary({ calls: [wrote('a'), ran(command)] })).toContain('**Verified**')
      }
    )
  })

  describe('what it looked at', () => {
    it('names the files examined, not just how many calls it made', () => {
      const text = summary({ calls: [read('src/a.ts'), read('src/b.ts')] })
      expect(text).toContain('2 reads')
      expect(text).toContain('`src/a.ts`')
      expect(text).toContain('`src/b.ts`')
    })

    it('caps the named files and says how many it left out', () => {
      const calls = Array.from({ length: 9 }, (_, index) => read(`src/f${index}.ts`))
      expect(summary({ calls })).toContain('and 3 more')
    })

    it('reports searches, which touch no single file', () => {
      const text = summary({
        calls: [
          call({ name: 'search_files', kind: 'read' }),
          call({ name: 'list_directory', kind: 'read' })
        ]
      })
      expect(text).toContain('2 searches')
    })
  })

  describe('what it left open', () => {
    const plan = (statuses: Plan['steps'][number]['status'][]): Plan =>
      ({
        steps: statuses.map((status, index) => ({
          id: `s${index}`,
          title: `Step ${index}`,
          status
        }))
      }) as Plan

    it('lists the steps still open', () => {
      const text = summary({ calls: [read('a')], plan: plan(['completed', 'pending', 'pending']) })
      expect(text).toContain('1 of 3 steps complete')
      expect(text).toContain('Step 1; Step 2')
    })

    it('says when the plan is done', () => {
      const text = summary({ calls: [read('a')], plan: plan(['completed', 'completed']) })
      expect(text).toContain('all 2 steps complete')
    })
  })

  describe('why it ended', () => {
    it('explains a reply the gathering ladder cut short', () => {
      const text = summary({ calls: [read('a')], blockedGathering: 3 })
      expect(text).toContain('**Ended early**')
      expect(text).toContain('3 further information-gathering call(s)')
    })

    // The silent break: a chat turn that ran out of rounds recorded nothing
    // anywhere, so a reply ending mid-sentence had no explanation at all.
    it('explains a turn that ran out of tool-calling rounds', () => {
      const text = summary({
        calls: [read('a')],
        endedBecause: 'it reached the limit of 24 tool-calling rounds for a single reply.'
      })
      expect(text).toContain('**Ended early**')
      expect(text).toContain('24 tool-calling rounds')
    })

    it('says nothing about ending when the turn simply finished', () => {
      expect(summary({ calls: [read('a')], endedBecause: null })).not.toContain('Ended early')
    })

    // The ladder is the more specific cause; two explanations for one ending
    // is worse than one.
    it('prefers the ladder refusal over the loop running out of rounds', () => {
      const text = summary({
        calls: [read('a')],
        blockedGathering: 2,
        endedBecause: 'it reached the limit of 24 tool-calling rounds.'
      })
      expect(text).toContain('were refused')
      expect(text).not.toContain('24 tool-calling rounds')
    })

    // This used to stay silent, on the reasoning that a stop renders its own
    // banner. A live run refused ten gathering calls, broke off mid-sentence,
    // and told the user nothing — the banner does not reach them. A duplicate
    // explanation costs a line; a silent stop costs the whole account.
    it('still explains an ending even when the turn reports a stop', () => {
      const text = summary({ calls: [read('a')], blockedGathering: 3, stopped: true })
      expect(text).toContain('**Ended early**')
      expect(text).toContain('What this reply did')
    })
  })

  describe('what to check', () => {
    const issue = (path: string, reason: PathClaimIssue['reason']): PathClaimIssue => ({
      path,
      reason
    })

    it('flags a cited path that does not exist', () => {
      const text = summary({
        calls: [read('a')],
        unverifiedPaths: [issue('src/ghost.ts', 'not-found')]
      })
      expect(text).toContain('`src/ghost.ts`')
      expect(text).toContain('does not exist here')
    })

    // The worst case, and the one the old zero-call guard nearly lost: a reply
    // that did no work at all and still cited files by name.
    it('flags a fabricated path even when the reply called no tools', () => {
      const text = summary({ unverifiedPaths: [issue('src/ghost.ts', 'not-found')] })
      expect(text).toContain('`src/ghost.ts`')
      expect(text).toContain('likely fabricated or misspelled')
    })

    it('flags a path mentioned but never opened', () => {
      const text = summary({
        calls: [read('a')],
        unverifiedPaths: [issue('src/x.ts', 'not-inspected')]
      })
      expect(text).toContain('without opening it')
    })

    it('flags a screenshot that a later change invalidated', () => {
      const text = summary({
        calls: [call({ name: 'inspect_visual', kind: 'read' }), wrote('src/a.ts')]
      })
      expect(text).toContain('most recent screenshot')
      expect(text).toContain('sectionId')
    })

    it('does not flag a screenshot taken after the change', () => {
      const text = summary({
        calls: [wrote('src/a.ts'), call({ name: 'inspect_visual', kind: 'read' })]
      })
      expect(text).not.toContain('most recent screenshot')
    })

    it('does not ask about pixels on a task that never looked at any', () => {
      expect(summary({ calls: [wrote('src/a.ts')] })).not.toContain('most recent screenshot')
    })
  })
})

describe('isDurableChange', () => {
  it('counts a successful write', () => {
    expect(isDurableChange(wrote('src/a.ts'))).toBe(true)
  })

  it('does not count a failed write', () => {
    expect(isDurableChange({ ...wrote('src/a.ts'), status: 'error' })).toBe(false)
  })

  // A refusal or no-op reports `madeProgress: false` precisely so it cannot buy
  // a continuation cycle or read as work.
  it('does not count a call that reported no progress', () => {
    expect(isDurableChange({ ...wrote('src/a.ts'), madeProgress: false })).toBe(false)
  })

  it('does not count a read', () => {
    expect(isDurableChange(read('src/a.ts'))).toBe(false)
  })
})
