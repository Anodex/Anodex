import { createLogger } from '../utils/logger'

const log = createLogger('llama:detokenize')

/**
 * The slice of node-llama-cpp's native model handle this module touches.
 *
 * `detokenize` is the single path every generated character takes on its way
 * out of the engine — streamed text, the final reply, and the arguments of a
 * native function call alike. `getTokenString` returns a token's raw entry in
 * the vocabulary, before any decoding.
 */
export interface NativeVocabulary {
  detokenize: (tokens: Uint32Array, specialTokens?: boolean) => string
  getTokenString: (token: number) => string | undefined
  getTokenAttributes: (token: number) => number
}

export type ExactDetokenizeOutcome = 'not-needed' | 'installed' | 'unsupported'

/**
 * Strings that must come back from the engine exactly as they went in.
 *
 * llama.cpp's `llama_detokenize` applies Hugging Face's
 * `clean_up_tokenization_spaces` to Llama 3 vocabularies: it drops the space
 * before `.`, `,`, `?` and `!`, and before a quote that starts with s, t, m or
 * d, taking those for the contractions in "it's" or "I'm". In prose that is a
 * cosmetic slip. In a shell command it is a different command. Measured with
 * Llama 3.1 8B: `echo 'see you at 5'` arrived as `echo'see you at 5'`,
 * `printf 'milk…'` as `printf'milk…'`, `find . -name` as `find. -name` and
 * `cd ..` as `cd..`. Eight of thirteen ordinary commands were changed, and the
 * model was blamed for typing them. llama.cpp's own server decodes token by
 * token and never applies the cleanup, which is why the same model is fine
 * there.
 */
const PROBES = [
  "find . -name '*.pdf'",
  'cd .. && ls',
  "echo 'see you at 5'",
  "printf 'milk\\neggs' , done ?",
  "It's Sam's café — naïve 日本語 🙂"
]

/** llama.cpp's own token attribute bits. */
const ATTR_UNKNOWN = 1
const ATTR_CONTROL = 8
const ATTR_USER_DEFINED = 16

/**
 * Decode a model's tokens exactly, for a model whose engine rewrites spacing.
 *
 * Only acts when the probes show the engine is actually changing text, and
 * only for byte-level BPE vocabularies, the kind Llama 3 uses and the kind this
 * decoder reproduces. It then re-runs the probes through the replacement and
 * puts the engine's own decoder back if any of them is not returned exactly. So
 * an unaffected model is left untouched, and an affected model either decodes
 * exactly or keeps the behaviour it had.
 */
export function installExactDetokenize(
  native: NativeVocabulary,
  tokenize: (text: string) => readonly number[],
  vocabularyType: string
): ExactDetokenizeOutcome {
  const original = native.detokenize.bind(native)
  const roundTrips = (decode: (tokens: Uint32Array) => string): boolean =>
    PROBES.every((probe) => decode(Uint32Array.from(tokenize(probe))) === probe)

  if (roundTrips((tokens) => original(tokens, false))) return 'not-needed'
  if (vocabularyType !== 'bpe') {
    log.warn('The engine rewrites spacing in generated text, and this vocabulary is not BPE.')
    return 'unsupported'
  }

  const decoder = new ByteLevelDecoder(native)
  const ownBefore = Object.getOwnPropertyDescriptor(native, 'detokenize')
  // The native method is a read-only prototype property, so assignment is
  // refused; defining it on this one instance shadows it for this model only.
  Object.defineProperty(native, 'detokenize', {
    value: (tokens: Uint32Array, specialTokens = false) => decoder.decode(tokens, specialTokens),
    configurable: true,
    writable: true
  })
  if (!roundTrips((tokens) => native.detokenize(tokens, false))) {
    if (ownBefore) Object.defineProperty(native, 'detokenize', ownBefore)
    else delete (native as { detokenize?: unknown }).detokenize
    log.warn('Exact decoding did not round-trip; keeping the engine decoder.')
    return 'unsupported'
  }
  log.info('Generated text is decoded exactly; the engine would have rewritten its spacing.')
  return 'installed'
}

/**
 * GPT-2's byte-level encoding, reversed: each vocabulary character stands for
 * one byte. Printable Latin-1 bytes stand for themselves; the rest were moved
 * to code points from 256 up, in order.
 */
function byteDecoder(): Map<number, number> {
  const bytes: number[] = []
  const add = (from: string, to: string): void => {
    for (let b = from.charCodeAt(0); b <= to.charCodeAt(0); b++) bytes.push(b)
  }
  add('!', '~')
  add('¡', '¬')
  add('®', 'ÿ')
  const map = new Map<number, number>()
  for (const b of bytes) map.set(b, b)
  let shifted = 0
  for (let b = 0; b < 256; b++) {
    if (!map.has(b)) map.set(256 + shifted++, b)
  }
  return map
}

class ByteLevelDecoder {
  private readonly bytesOf = byteDecoder()
  private readonly cache = new Map<number, Uint8Array>()
  private readonly utf8 = new TextDecoder('utf-8')
  private readonly encoder = new TextEncoder()

  constructor(private readonly native: NativeVocabulary) {}

  /** What `llama_token_to_piece` gives for each token, joined, with no cleanup. */
  decode(tokens: Uint32Array, specialTokens: boolean): string {
    const parts: Uint8Array[] = []
    let length = 0
    for (const token of tokens) {
      const piece = this.piece(token, specialTokens)
      parts.push(piece)
      length += piece.length
    }
    const joined = new Uint8Array(length)
    let offset = 0
    for (const part of parts) {
      joined.set(part, offset)
      offset += part.length
    }
    return this.utf8.decode(joined)
  }

  private piece(token: number, specialTokens: boolean): Uint8Array {
    const attributes = this.native.getTokenAttributes(token)
    // Control and unknown tokens are only ever text when asked for.
    if ((attributes & (ATTR_CONTROL | ATTR_UNKNOWN)) !== 0) {
      return specialTokens ? this.encoder.encode(this.native.getTokenString(token) ?? '') : EMPTY
    }
    const cached = this.cache.get(token)
    if (cached) return cached
    const text = this.native.getTokenString(token) ?? ''
    let piece: Uint8Array
    if ((attributes & ATTR_USER_DEFINED) !== 0) {
      piece = this.encoder.encode(text)
    } else {
      const bytes: number[] = []
      for (const char of text) {
        const code = char.codePointAt(0) ?? 0
        const byte = this.bytesOf.get(code)
        if (byte !== undefined) bytes.push(byte)
        else bytes.push(...this.encoder.encode(char))
      }
      piece = Uint8Array.from(bytes)
    }
    this.cache.set(token, piece)
    return piece
  }
}

const EMPTY = new Uint8Array(0)
