import { describe, expect, it } from 'vitest'
import { installExactDetokenize, type NativeVocabulary } from '../exactDetokenize'

/** GPT-2's byte-to-character table, the encoding byte-level BPE vocabularies store. */
function byteEncoder(): Map<number, string> {
  const bytes: number[] = []
  for (const [from, to] of [
    ['!', '~'],
    ['¡', '¬'],
    ['®', 'ÿ']
  ]) {
    for (let b = from.charCodeAt(0); b <= to.charCodeAt(0); b++) bytes.push(b)
  }
  const map = new Map<number, string>()
  for (const b of bytes) map.set(b, String.fromCharCode(b))
  let shifted = 0
  for (let b = 0; b < 256; b++) {
    if (!map.has(b)) map.set(b, String.fromCharCode(256 + shifted++))
  }
  return map
}

const EOT = 1_000_000

/**
 * A vocabulary of one token per character, stored byte-level encoded as a real
 * BPE vocabulary is, whose engine decoder applies llama.cpp's space cleanup
 * (or not, for a vocabulary the engine leaves alone).
 */
function fakeVocabulary(cleansSpaces: boolean): {
  native: NativeVocabulary
  tokenize: (text: string) => number[]
} {
  const encode = byteEncoder()
  const utf8 = new TextEncoder()
  const tokenize = (text: string): number[] => [...text].map((char) => char.codePointAt(0) ?? 0)
  const native: NativeVocabulary = {
    getTokenString: (token) =>
      token === EOT
        ? '<|eot_id|>'
        : [...utf8.encode(String.fromCodePoint(token))].map((b) => encode.get(b)).join(''),
    getTokenAttributes: (token) => (token === EOT ? 8 : 4),
    detokenize: (tokens, special) => {
      const text = [...tokens]
        .map((token) =>
          token === EOT ? (special ? '<|eot_id|>' : '') : String.fromCodePoint(token)
        )
        .join('')
      return cleansSpaces ? text.replace(/ ([.,?!])/g, '$1').replace(/ '([stmd])/g, "'$1") : text
    }
  }
  return { native, tokenize }
}

const decode = (native: NativeVocabulary, tokens: number[], special = false): string =>
  native.detokenize(Uint32Array.from(tokens), special)

describe('installExactDetokenize', () => {
  it('decodes exactly where the engine would rewrite spacing in a command', () => {
    const { native, tokenize } = fakeVocabulary(true)
    expect(decode(native, tokenize("echo 'see you' && cd .."))).toBe("echo'see you' && cd..")

    expect(installExactDetokenize(native, tokenize, 'bpe')).toBe('installed')

    for (const text of [
      "echo 'see you at 5'",
      "find . -name '*.pdf'",
      'cd .. && ls',
      'Grüße — 日本 🙂, ok ?'
    ]) {
      expect(decode(native, tokenize(text))).toBe(text)
    }
  })

  it('still shows a control token only when asked to', () => {
    const { native, tokenize } = fakeVocabulary(true)
    installExactDetokenize(native, tokenize, 'bpe')
    expect(decode(native, [...tokenize('done'), EOT])).toBe('done')
    expect(decode(native, [...tokenize('done'), EOT], true)).toBe('done<|eot_id|>')
  })

  it('leaves a model alone when its engine already returns text exactly', () => {
    const { native, tokenize } = fakeVocabulary(false)
    const before = native.detokenize
    expect(installExactDetokenize(native, tokenize, 'bpe')).toBe('not-needed')
    expect(native.detokenize).toBe(before)
  })

  it('keeps the engine decoder for a vocabulary it cannot reproduce', () => {
    const { native, tokenize } = fakeVocabulary(true)
    const before = native.detokenize
    expect(installExactDetokenize(native, tokenize, 'spm')).toBe('unsupported')
    expect(native.detokenize).toBe(before)
  })

  it('puts the engine decoder back if its own decoding does not round-trip', () => {
    const { native, tokenize } = fakeVocabulary(true)
    const before = native.detokenize
    const broken: NativeVocabulary = { ...native, getTokenString: () => 'x' }
    expect(installExactDetokenize(broken, tokenize, 'bpe')).toBe('unsupported')
    expect(broken.detokenize).toBe(before)
  })
})
