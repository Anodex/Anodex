import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@shared/tools.types'
import { buildContinuationBrief } from '../continuationBrief'

let sequence = 0

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  sequence++
  return {
    id: `call_${sequence}`,
    name: 'read_file',
    kind: 'read',
    title: 'Read: index.html',
    status: 'success',
    ...overrides
  }
}

const read = (path: string): ToolCall =>
  call({ name: 'read_file', kind: 'read', title: `Read: ${path}`, touchedPaths: [path] })

const write = (path: string): ToolCall =>
  call({ name: 'replace_lines', kind: 'write', title: `Edit: ${path}`, touchedPaths: [path] })

const inspect = (): ToolCall =>
  call({ name: 'inspect_visual', kind: 'read', title: 'Inspect: index.html' })

const OBJECTIVE = 'the page is black and shows no planets'

describe('buildContinuationBrief', () => {
  it('says nothing when nothing has settled', () => {
    expect(buildContinuationBrief({ objective: OBJECTIVE, calls: [] })).toBeNull()
  })

  it('names the objective, what changed, and what was already read', () => {
    const brief = buildContinuationBrief({
      objective: OBJECTIVE,
      calls: [read('index.html'), read('js/universe-sandbox.js'), write('index.html')]
    })

    expect(brief).toContain(OBJECTIVE)
    expect(brief).toContain('Changed so far: index.html')
    expect(brief).toContain('js/universe-sandbox.js')
    expect(brief).toContain('Re-read one only if it has changed since.')
  })

  it('counts repeated reads of the same file once, and says how many calls it took', () => {
    const brief = buildContinuationBrief({
      objective: OBJECTIVE,
      calls: [read('index.html'), read('index.html'), read('index.html')]
    })

    expect(brief).toContain('3 call(s) over 1 file(s)')
  })

  it('states the gathering-without-progress case a read loop lands in', () => {
    // The measured 8K failure: many successful reads, no edit, no inspection.
    const brief = buildContinuationBrief({
      objective: OBJECTIVE,
      calls: Array.from({ length: 24 }, () => read('index.html'))
    })

    expect(brief).toContain('Changed so far: nothing')
    expect(brief).toContain('nothing has been changed yet, after 24 information-gathering call(s)')
  })

  it('flags a change made after the last visual inspection', () => {
    const brief = buildContinuationBrief({
      objective: OBJECTIVE,
      calls: [inspect(), write('index.html')]
    })

    expect(brief).toContain('no longer proves anything')
  })

  it('does not flag inspection that already followed the change', () => {
    const brief = buildContinuationBrief({
      objective: OBJECTIVE,
      calls: [write('index.html'), inspect()]
    })

    expect(brief).not.toContain('no longer proves anything')
    expect(brief).not.toContain('nothing has been changed yet')
    expect(brief).not.toContain('nothing has checked the change')
  })

  it('flags a change that nothing has checked at all', () => {
    // The measured 16K run: five successful edits, no build/test command, no
    // inspection, and a closing claim that the fix worked.
    const brief = buildContinuationBrief({
      objective: OBJECTIVE,
      calls: [read('index.html'), write('index.html'), read('index.html')]
    })

    expect(brief).toContain('nothing has checked the change yet')
    expect(brief).toContain('re-reading the file you just edited is not verification')
  })

  it('accepts a check command that ran after the change', () => {
    const brief = buildContinuationBrief({
      objective: OBJECTIVE,
      calls: [
        write('js/universe-sandbox.js'),
        call({
          name: 'run_command',
          kind: 'command',
          title: 'Run: npm run build',
          detail: 'exit 0'
        })
      ]
    })

    expect(brief).not.toContain('nothing has checked the change')
  })

  it('says nothing is outstanding on a reply that only looked and then answered', () => {
    const brief = buildContinuationBrief({
      objective: 'explain how the carousel works',
      calls: [read('js/carousel.js')]
    })

    expect(brief).not.toContain('nothing has checked the change')
  })

  it('ignores calls that have not settled', () => {
    const brief = buildContinuationBrief({
      objective: OBJECTIVE,
      calls: [read('index.html'), call({ status: 'running', title: 'Read: pending.html' })]
    })

    expect(brief).toContain('1 call(s) over 1 file(s)')
  })

  it('sheds the file lists rather than the objective on a small window', () => {
    const calls = Array.from({ length: 40 }, (_, index) =>
      read(`src/very/deeply/nested/path/number/${index}/component.tsx`)
    )
    const brief = buildContinuationBrief({
      objective: OBJECTIVE,
      calls,
      contextWindowTokens: 2_048
    })!

    expect(brief).not.toContain('component.tsx')
    expect(brief).toContain(OBJECTIVE)
    expect(brief).toContain('Take the next concrete action')
  })

  it('keeps every un-sheddable line inside the floor its budget promises', () => {
    // Guards `IRREDUCIBLE_BRIEF_CHARS`: the header, objective, outstanding item
    // and instruction can never be dropped, so the smallest budget has to be
    // big enough to hold them or it is a limit the renderer just ignores.
    const worst = buildContinuationBrief({
      objective: 'x'.repeat(400),
      calls: Array.from({ length: 99 }, () => read('a.ts')),
      contextWindowTokens: 1
    })!

    expect(worst.length).toBeLessThanOrEqual(520)
  })

  it('scales with the window rather than using one fixed size', () => {
    const calls = Array.from({ length: 40 }, (_, index) =>
      read(`src/very/deeply/nested/path/number/${index}/component.tsx`)
    )
    const small = buildContinuationBrief({
      objective: OBJECTIVE,
      calls,
      contextWindowTokens: 2_048
    })!
    const large = buildContinuationBrief({
      objective: OBJECTIVE,
      calls,
      contextWindowTokens: 32_768
    })!

    expect(large.length).toBeGreaterThan(small.length)
  })
})
