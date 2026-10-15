/**
 * Notices a native tool call whose arguments the model has lost track of.
 *
 * Measured with Gemma 4 E4B on Windows, "How much free disk space do I have?"
 * ended this way 2 of 8 times, each one the full 15-minute time limit with
 * nothing on screen. The model wrote `{"check": "disk", "name": "C:\"`: in
 * JSON the backslash makes that quote part of the text, so the string never
 * closed. The model carried on as if it had: it wrote its end-of-call marker,
 * its thoughts, and then its whole answer, inventing drives D: to K:, all of it
 * inside one argument the grammar would not let it leave. 6,444 tokens and
 * 35,399 characters, and `check_computer` takes a few words.
 *
 * The sign in every case was the model's own turn markers (`<tool_call|>`,
 * `<|channel>`) appearing inside the arguments. A model writes those only to
 * structure its turn, never as the value of a field, so seeing one there means
 * the call has already gone wrong; waiting longer only spends the turn.
 *
 * "Its own" is decided by the model's vocabulary, not a list: a marker this
 * model reads as one token is one of its markers. Measured on both bundled
 * models, Gemma 4 reads `<tool_call|>` and `<|channel>` as one token and
 * Llama 3.1's `<|eot_id|>` as seven; Llama reads `<|eot_id|>` and
 * `<|python_tag|>` as one and Gemma's markers as four or five. ChatML's
 * `<|im_start|>`, as text in a file being written, is six tokens to both and is
 * left alone. Gemma 4 does not flag its markers as special tokens at all, which
 * is why the test is the token count.
 */
export class RunawayToolCallWatch {
  /** The end of each in-flight call's arguments, so a marker split across chunks is still seen. */
  private readonly tails = new Map<number, string>()

  /**
   * @param isModelToken whether `marker` is a single token of this model's
   * vocabulary: see `LlamaService`, which asks the model's tokenizer.
   */
  constructor(private readonly isModelToken: (marker: string) => boolean) {}

  /** True once the call at `callIndex` has written one of the model's own turn markers. */
  observe(callIndex: number, chunk: string): boolean {
    const text = (this.tails.get(callIndex) ?? '') + chunk
    this.tails.set(callIndex, text.slice(-TAIL_CHARS))
    for (const [marker] of text.matchAll(MARKER_SHAPE)) {
      if (this.isModelToken(marker)) return true
    }
    return false
  }
}

/** `<|word>`, `<word|>` and `<|word|>`: the shapes chat templates give their markers. */
const MARKER_SHAPE = /<\|[A-Za-z_]{1,32}\|?>|<[A-Za-z_]{1,32}\|>/g

/** Longer than any marker, short enough to scan on every chunk. */
const TAIL_CHARS = 40
