import { describe, expect, it } from 'vitest'
import { repairLoneSurrogatesDeep, replaceLoneSurrogates } from '../loneSurrogates'

const ROCKET = '🚀'

describe('lone surrogate repair', () => {
  it('leaves ordinary text untouched', () => {
    expect(replaceLoneSurrogates('plain ascii')).toBe('plain ascii')
    expect(replaceLoneSurrogates(`emoji ${ROCKET} intact`)).toBe(`emoji ${ROCKET} intact`)
    expect(replaceLoneSurrogates('accented café — dash')).toBe('accented café — dash')
  })

  it('repairs a pair cut in half by slicing to a character budget', () => {
    // Exactly how it happens: a budget lands between the two halves.
    const text = `read ${ROCKET} more`
    const cut = text.slice(0, text.indexOf(ROCKET) + 1)
    expect(cut.endsWith('\uD83D')).toBe(true)

    const repaired = replaceLoneSurrogates(cut)
    expect(repaired.endsWith('�')).toBe(true)
    expect(JSON.stringify(repaired)).not.toMatch(/\ud83d/i)
  })

  it('repairs a trailing half left at the start of a slice', () => {
    const text = `read ${ROCKET} more`
    const tail = text.slice(text.indexOf(ROCKET) + 1)
    expect(tail.startsWith('\uDE80')).toBe(true)
    expect(replaceLoneSurrogates(tail).startsWith('�')).toBe(true)
  })

  it('walks a message payload without changing its shape', () => {
    const messages = [
      { role: 'user', content: `hi ${ROCKET}` },
      {
        role: 'assistant',
        content: [{ type: 'text', text: `broken ${'\uD83D'}` }],
        tool_calls: [{ function: { name: 'read', arguments: `{"path":"a${'\uDE80'}"}` } }]
      }
    ]
    const repaired = repairLoneSurrogatesDeep(messages)

    expect(repaired[0]).toEqual({ role: 'user', content: `hi ${ROCKET}` })
    expect(repaired[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'broken �' }],
      tool_calls: [{ function: { name: 'read', arguments: '{"path":"a�"}' } }]
    })
  })

  it('preserves values that are not strings', () => {
    expect(repairLoneSurrogatesDeep({ n: 1, b: true, z: null, u: undefined })).toEqual({
      n: 1,
      b: true,
      z: null,
      u: undefined
    })
  })
  it('returns the very same object when nothing needs repairing', () => {
    // The messages array is shared and appended to across rounds, and a turn's
    // payload runs to hundreds of kilobytes. Rebuilding it every round would
    // cost memory and hand the caller a different array than the one it is
    // accumulating into.
    const messages = [{ role: 'user', content: `hi ${ROCKET}` }]
    expect(repairLoneSurrogatesDeep(messages)).toBe(messages)
    expect(repairLoneSurrogatesDeep(messages)[0]).toBe(messages[0])
  })

  it('copies only the branches it had to repair', () => {
    const clean = { role: 'user', content: 'fine' }
    const broken = { role: 'user', content: '\uD83D' }
    const messages = [clean, broken]
    const repaired = repairLoneSurrogatesDeep(messages)

    expect(repaired).not.toBe(messages)
    expect(repaired[0]).toBe(clean)
    expect(repaired[1]).not.toBe(broken)
    expect(broken.content).toBe('\uD83D')
  })
})
