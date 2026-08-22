/**
 * Strip JSON Schema bounds that llama.cpp's grammar parser refuses to compile.
 *
 * node-llama-cpp turns every schema it is handed — a tool's `params`, or a
 * `jsonSchema` generation option — into GBNF, and a bounded string/array/object
 * becomes a literal repetition rule: `maxLength: 4000` on a string emits
 * `( string-char-rule ){0,4000}`. llama.cpp's grammar parser rejects any
 * repetition count of 2,000 or more outright — "number of repetitions exceeds
 * sane defaults, please reduce the number of repetitions" — and node-llama-cpp
 * surfaces that as a bare `Error: Failed to parse grammar` from
 * `new LlamaGrammar`, with no mention of which schema or which field caused it.
 *
 * That is not hypothetical. `write_file`, `append_file`, and `replace_lines`
 * each declared `maxLength: MAX_FILE_WRITE_CONTENT_CHARS` (4,000), so on the
 * node-llama-cpp path *every* call to one of them died the moment the model
 * named the tool: the params grammar is built per call, from that tool's schema
 * alone (`FunctionCallParamsGrammar`), so the read tools kept working and the
 * turn failed only once the model tried to write. A local chat could read code
 * all day and could never edit it.
 *
 * The bound is dropped rather than clamped down to a compilable number.
 * Clamping is the more dangerous repair: a grammar that permits only the first
 * 1,999 characters does not make the model write less, it forces the JSON
 * string closed mid-payload, and the tool then commits a silently truncated
 * file. Every capped tool already enforces its own limit in the handler and
 * reports it back to the model as an ordinary tool error, and states it in the
 * tool description — so an unbounded grammar loses no enforcement, only a
 * redundant one.
 *
 * Applied at the node-llama-cpp seam, not in the tool definitions: `maxLength`
 * is valid, useful JSON Schema for the cloud providers, which receive the same
 * declarations through `toolParameterSchema` and have no such limit.
 */

/**
 * Largest repetition count left in place. llama.cpp's own cutoff is 2,000
 * (1,999 compiles, 2,000 does not — measured directly against the bundled
 * binary, per-rule rather than summed across the grammar). This sits well
 * under it: the constant is a "sane default" in llama.cpp's own words, free to
 * move between releases, and no schema here needs to sit near the edge.
 */
export const GBNF_MAX_SAFE_REPETITIONS = 1_000

/**
 * Every JSON Schema keyword node-llama-cpp compiles into a repetition count.
 * Both ends matter: a minimum emits `{n,}` just as a maximum emits `{0,n}`.
 */
const REPETITION_BOUND_KEYS = new Set([
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties'
])

/**
 * Deep copy of `schema` with every out-of-range repetition bound removed.
 *
 * Structure-preserving and total: anything that is not a bound key is copied
 * through untouched, so an unrecognised or future schema keyword is never lost.
 * Returns the input unchanged when it is not an object (a `const` value, an
 * enum member) — those carry no bounds.
 */
export function gbnfSafeSchema<T>(schema: T): T {
  return sanitize(schema) as T
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize)
  if (value == null || typeof value !== 'object') return value

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      REPETITION_BOUND_KEYS.has(key) &&
      typeof child === 'number' &&
      child > GBNF_MAX_SAFE_REPETITIONS
    ) {
      continue
    }
    result[key] = sanitize(child)
  }
  return result
}
