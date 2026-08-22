/**
 * Recent llama.cpp log lines, kept so a failed load can say what actually went
 * wrong.
 *
 * node-llama-cpp does not surface the native diagnostic to JS: every failed
 * `loadModel` rejects with the bare string "Failed to load model", whatever the
 * cause. The real reason is printed by llama.cpp itself — measured directly, a
 * model whose architecture the bundled engine has never heard of fails with
 * `unknown model architecture: 'muse-glimmer'` on the native log and nothing
 * else. Anodex's own message then told the user to free RAM and try a smaller
 * model, none of which could ever work, because memory is the only cause it
 * knew how to describe.
 *
 * Keeping the tail of the native log is the only way to tell those apart, and
 * it matters most for exactly the models this app exists to run: a local GGUF
 * from anywhere, of any vintage, against one bundled engine build.
 */

/** How many lines to keep. A failing load reports its cause within a handful. */
const RETAINED_LINES = 64

export interface NativeLogTail {
  /** Record one line as llama.cpp emits it. */
  record(message: string): void
  /** The retained lines, oldest first. */
  lines(): string[]
}

export function createNativeLogTail(limit: number = RETAINED_LINES): NativeLogTail {
  const buffer: string[] = []
  return {
    record(message) {
      buffer.push(message)
      if (buffer.length > limit) buffer.splice(0, buffer.length - limit)
    },
    lines: () => [...buffer]
  }
}

/**
 * An architecture the bundled llama.cpp build cannot read at all.
 *
 * Distinct from every other load failure in that no setting the user can reach
 * will help — not CPU-only, not a smaller context, not closing other apps. The
 * model needs a newer engine build, or a different model.
 */
const UNKNOWN_ARCHITECTURE = /unknown model architecture:\s*'([^']+)'/i

/**
 * A specific, actionable explanation drawn from the native log, or `null` when
 * nothing in it is recognised — in which case the caller keeps its general
 * guidance rather than inventing a cause.
 */
/**
 * A GGUF whose header cannot be parsed at all.
 *
 * This one fails on the JS side, before llama.cpp ever sees the file, so it
 * leaves nothing in the native log — the reader tries to size a buffer from a
 * field it just read and throws Node's own range error. Observed directly on a
 * truncated Llama-3.2-3B download: `The value of "size" is out of range […]
 * Received 14_029_557_264_190_018_000`, a length no file could have. The
 * general memory guidance is wrong here too: a partial download does not get
 * better with more RAM.
 */
const UNREADABLE_GGUF = /value of "size" is out of range/i

/**
 * An explanation for a model file that could not be read, or `null` when the
 * error is not one of these.
 */
export function describeUnreadableModelFile(rawError: string): string | null {
  if (!UNREADABLE_GGUF.test(rawError)) return null
  return (
    'That .gguf file could not be read — its header describes a size the file does not have, ' +
    'which normally means the download was interrupted or the file is corrupt. Downloading it ' +
    'again is the fix; memory and context settings make no difference here.'
  )
}

export function describeNativeLoadFailure(lines: readonly string[]): string | null {
  // Newest first: a session may hold lines from an earlier, successful load.
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = UNKNOWN_ARCHITECTURE.exec(lines[index])
    if (match) {
      return (
        `This model's architecture (${match[1]}) is not supported by the llama.cpp engine ` +
        'bundled with this version of Anodex. That is a property of the model file, not of ' +
        'your hardware — a smaller context or CPU-only mode will not help. It usually means ' +
        'the model is newer than the bundled engine, so try a model in an established format ' +
        '(Llama, Qwen, Mistral, Gemma, DeepSeek), or wait for an Anodex update.'
      )
    }
  }
  return null
}
