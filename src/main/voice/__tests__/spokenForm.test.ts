import { describe, expect, it } from 'vitest'
import { toSpokenForm } from '../spokenForm'

/**
 * What a written reply becomes before anybody says it.
 *
 * This looks like tidying and is actually the second-largest speed fix in the
 * feature. One real sentence, measured on the same machine at the same moment:
 * with its markdown and brackets it took 40.4 s to generate, and as plain prose
 * it took 11.8 s for *more* audio. Symbols are not merely pronounced, they are
 * expensive — so every rule below is worth seconds, not just dignity.
 */
describe('a reply, made sayable', () => {
  it('does not read code out loud', () => {
    const spoken = toSpokenForm('Here is the fix:\n\n```ts\nconst x = 1\n```\n\nThat should do it.')
    expect(spoken).not.toContain('const')
    expect(spoken).toContain('a code block')
    expect(spoken).toContain('That should do it.')
  })

  it('says nothing at all for a reply that is only code', () => {
    // The placeholder alone is not worth thirty seconds of generation and a
    // press of the button.
    expect(toSpokenForm('```\nnpm install\n```')).toBe('')
  })

  it('keeps the words of a link and drops the address', () => {
    // A URL read character by character is the worst thing a voice can do, and
    // it is also the slowest.
    const spoken = toSpokenForm('See [the handoff](docs/HANDOFF_VOICE.md) for why.')
    expect(spoken).toBe('See the handoff for why.')
  })

  it('replaces a bare address rather than spelling it', () => {
    expect(toSpokenForm('Grab it from https://example.com/a/b?c=d now.')).toBe(
      'Grab it from a link now.'
    )
  })

  it('drops emphasis without dropping the emphasised words', () => {
    expect(toSpokenForm('This is **really** important and _worth_ saying.')).toBe(
      'This is really important and worth saying.'
    )
  })

  it('turns an aside in brackets into an aside in commas', () => {
    expect(toSpokenForm('Python is available (no .NET here) so we can build.')).toBe(
      'Python is available, no .NET here, so we can build.'
    )
  })

  it('leaves numbers as numbers', () => {
    // Measured and deliberate: "three point fourteen" took 25.2 s against 11.8 s
    // for "3.14.6". Spelling numbers out reads no better and costs twice.
    expect(toSpokenForm('Python 3.14.6 is available.')).toContain('3.14.6')
  })

  it('strips the scaffolding of headings, bullets and tables', () => {
    const spoken = toSpokenForm(
      '## What changed\n\n- the first thing\n- the second thing\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
    )
    expect(spoken).not.toMatch(/[#|*-]/)
    expect(spoken).toContain('What changed')
    expect(spoken).toContain('the first thing')
  })

  it('keeps the punctuation that shapes a sentence', () => {
    const spoken = toSpokenForm('Wait — is it ready? Yes; it is. Good!')
    expect(spoken).toBe('Wait — is it ready? Yes; it is. Good!')
  })

  it('leaves ordinary prose exactly alone', () => {
    // The commonest case by far, and the one where a clever rule does damage.
    const plain = 'Workspace is empty — a fresh project. I will start on the plan now.'
    expect(toSpokenForm(plain)).toBe(plain)
  })

  it('handles the reply that took five minutes', () => {
    // The one that was reported. Every symbol left in here costs real seconds.
    const real =
      "Python 3.14.6 is available (no .NET, no ffmpeg) — so I'll build a real native " +
      'desktop app in **Python + PySide6 (Qt 6)**: a compiled GUI program.'
    const spoken = toSpokenForm(real)
    expect(spoken).not.toContain('**')
    expect(spoken).not.toContain('(')
    expect(spoken).not.toContain('+')
    expect(spoken).toContain('PySide6')
    expect(spoken).toContain('ffmpeg')
  })
})
