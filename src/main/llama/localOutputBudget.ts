/**
 * The smallest reply allowance worth issuing a round with.
 *
 * A percentage-only reserve lets a tiny tool-enabled window issue a request
 * that cannot finish one valid JSON call; an absolute 4096-token rule made
 * small tool-free requests impossible by arithmetic. This derives the floor
 * from capacity, then raises it to the known bounded write payload when tools
 * are present.
 *
 * Lives here rather than in `LlamaVisionService`, which is where it was
 * written and is still its main caller, because `reasoningOverrun` sizes the
 * thinking budget against it and importing it from there would close the loop
 * `LlamaVisionService -> LlamaServerRuntime -> reasoningOverrun`.
 */
export function minimumViableOutputTokens(contextSize: number, hasTools: boolean): number {
  const scaled = Math.max(384, Math.min(2_048, Math.floor(contextSize * 0.12)))
  return hasTools ? Math.max(scaled, MIN_TOOL_CALL_OUTPUT_TOKENS) : scaled
}

/**
 * The reply room one bounded tool call needs end to end.
 *
 * A round issued with less than this cannot finish a large `write_file` call,
 * and a cut-off call is replayed as the same malformed request rather than
 * failing cleanly.
 */
const MIN_TOOL_CALL_OUTPUT_TOKENS = 1_280

/**
 * The tools that can emit a payload large enough to need that floor.
 *
 * `MIN_TOOL_CALL_OUTPUT_TOKENS` is justified entirely by finishing one bounded
 * write: a round issued with less cannot complete a large `write_file`, and a
 * cut-off call is replayed as the same malformed request. None of that applies
 * to a surface that cannot write.
 */
const BOUNDED_WRITE_TOOLS = new Set([
  'write_file',
  'append_file',
  'edit_file',
  'replace_lines',
  'patch_file'
])

/**
 * Whether a surface holds any tool that could need the bounded-write floor.
 *
 * Charging that floor to a surface without one is the same defect as forcing a
 * builder-loop floor on a surface with no builder loop, and it was measured:
 * a 27B at 4096 whose chat surface held `web_search`, `fetch_url` and
 * `anodex_status` reached fixed input of 2,327 against a gate of
 * 3,584 - 1,280 = 2,304. It missed by 23 tokens and produced nothing on eleven
 * of twelve turns, reserving room to finish a call it had no tool to make.
 */
export function needsBoundedWriteHeadroom(toolNames: Iterable<string>): boolean {
  for (const name of toolNames) if (BOUNDED_WRITE_TOOLS.has(name)) return true
  return false
}

export interface LocalOutputBudgetInput {
  contextSize: number
  inputLimitTokens: number
  fixedTokens: number
  /** Current user request tokens already included in `fixedTokens`. */
  promptTokens?: number
  /** Share of the next window reserved for verbatim replay; null disables it. */
  recallWindowFraction?: number | null
  requestedMaxTokens: number | undefined
  hasFunctions: boolean
}

export interface LocalOutputBudget {
  requestedMaxTokens: number | undefined
  effectiveMaxTokens: number
  clamped: boolean
}

/**
 * A malformed/unfinished function call can't be removed by a context-shift
 * strategy (those pending tokens aren't part of `chatHistory`), so tool-
 * enabled turns keep a safety reserve carved out of the room this turn
 * actually has — not a fixed fraction of the whole context, which throws
 * away measured headroom that has nothing to do with the fixed prompt.
 * Bounded between a floor (still a meaningful reserve on a small available
 * window) and a ceiling (don't reserve away most of a large one). This
 * fraction/floor/ceiling are a starting experiment — the live 8K exit gate
 * in `docs/CONTEXT_ADAPTIVE_RUNTIME_RECOVERY_HANDOFF.md` is what should tune them
 * further, not intuition alone.
 */
const FUNCTION_SAFETY_RESERVE_FRACTION = 0.15
const MIN_FUNCTION_SAFETY_RESERVE = 256
const MAX_FUNCTION_SAFETY_RESERVE = 768
/** Never clamp a tool-enabled turn below this, even on a very tight window. */
const MIN_FUNCTION_OUTPUT_TOKENS = 512

/**
 * Bound one local generation to space that really exists after the wrapper,
 * system prompt, current request, and active function schemas are rendered.
 *
 * Tool-enabled turns reserve a bounded fraction of the *measured available*
 * room (see `boundedFunctionSafetyReserve`) as insurance against one
 * malformed call consuming everything with nothing to show for it — not a
 * flat quarter of the whole context, which could throw away most of a
 * turn's actual headroom regardless of how large the fixed prompt was.
 * Tool-less replies can use all measured space before the context-shift
 * reserve. When the Context Ledger has a bounded recall window, the ceiling
 * also keeps this request plus its reply small enough to replay next turn.
 */
export function resolveLocalOutputBudget(input: LocalOutputBudgetInput): LocalOutputBudget {
  const availableTokens = Math.max(1, input.inputLimitTokens - input.fixedTokens)
  const safeCeiling = input.hasFunctions
    ? Math.min(
        availableTokens,
        Math.max(
          MIN_FUNCTION_OUTPUT_TOKENS,
          availableTokens - boundedFunctionSafetyReserve(availableTokens)
        )
      )
    : availableTokens
  const replaySafeCeiling = replaySafeOutputCeiling(input)
  const boundedCeiling =
    replaySafeCeiling === undefined ? safeCeiling : Math.min(safeCeiling, replaySafeCeiling)
  const requested = normalizeRequestedMaxTokens(input.requestedMaxTokens)
  const effectiveMaxTokens =
    requested === undefined ? boundedCeiling : Math.min(requested, boundedCeiling)

  return {
    requestedMaxTokens: requested,
    effectiveMaxTokens,
    clamped: requested === undefined || requested > effectiveMaxTokens
  }
}

/**
 * Keep the newest user-led interaction inside the same recall allocation that
 * `historyBudgetTokens()` uses during the next session rebuild. Without this,
 * a reply could fit the current native context yet be too large to retain
 * verbatim later, pinning the meter at 100% until a failed context shift.
 *
 * **Never applied to a tool-enabled turn.** There, one generation is a round of
 * an agentic loop — usually a tool call — not the reply that will be replayed,
 * and the accumulated reply is small next to the tool traffic, which is already
 * bounded by `MAX_MODEL_TOOL_RESULT_CHARS` and `modelResultBudget`. Capping the
 * round instead of the reply produced a measured absurdity: with `fixedTokens`
 * at 8,462 of a 15,872 limit — 7,410 tokens genuinely free — round 0 of a fresh
 * cycle was held to 2,940, *less* than the round before it that had 3,700 more
 * fixed input. The turn then ended on "reached its safe local output limit of
 * 2,940 tokens" with the window two-thirds empty.
 *
 * The failure this ceiling exists for is a single large *answer*, which is a
 * tool-less turn — and that case still gets it.
 */
function replaySafeOutputCeiling(input: LocalOutputBudgetInput): number | undefined {
  if (input.hasFunctions) return undefined
  const fraction = input.recallWindowFraction
  if (fraction == null || !Number.isFinite(fraction)) return undefined

  // `fixedTokens` includes this prompt. Add it back to get the replayable
  // history pool (system + tools are excluded), then reserve the prompt inside
  // that pool before granting space to the reply.
  const promptTokens = Math.max(0, input.promptTokens ?? 0)
  const replayPool = Math.max(0, input.inputLimitTokens - input.fixedTokens + promptTokens)
  const replayBudget = Math.max(0, Math.floor(replayPool * fraction))
  return Math.max(1, replayBudget - promptTokens)
}

/**
 * Guaranteed minimum fraction of a turn's effective output cap reserved for
 * the visible reply/function call, rather than hidden reasoning. Observed
 * directly: a live 8K project-chat turn produced 3,432 hidden-thinking
 * characters against only 223 visible before exhausting its tool-call budget
 * — a reasoning-tuned model can spend nearly all of `maxTokens` on hidden
 * thinking before ever attempting a call unless something bounds it. A
 * starting hypothesis to tune against a real model, like the reserve fraction
 * above, not a proven production constant.
 */
const DEFAULT_MIN_VISIBLE_FRACTION = 0.6

/**
 * The largest hidden-reasoning budget a turn may be given, and the default
 * for turns that structurally require visible output (a function call or a
 * grammar-constrained reply) without naming their own budget.
 *
 * This is a CEILING, not just a default: a caller-supplied `thoughtTokens`
 * (see `GenerationOptions.thoughtTokens`) is sized against the cap that
 * caller *assumed*, while `effectiveMaxTokens` is what this turn's prompt
 * actually left room for. Clamping a request to the effective cap alone would
 * let the reserve silently reach 100% of it exactly when space is tightest —
 * the live failure this guards (Critical Thinking synthesis asked for 3,276
 * of an assumed 8,192 and produced a zero-character report). Applying this
 * ceiling keeps `DEFAULT_MIN_VISIBLE_FRACTION` of the *real* cap for the
 * answer no matter how far the ceiling collapsed.
 */
export function defaultThoughtTokenBudget(effectiveMaxTokens: number): number {
  const minVisible = Math.ceil(Math.max(0, effectiveMaxTokens) * DEFAULT_MIN_VISIBLE_FRACTION)
  return Math.max(0, effectiveMaxTokens - minVisible)
}

function boundedFunctionSafetyReserve(measuredAvailableTokens: number): number {
  return Math.min(
    MAX_FUNCTION_SAFETY_RESERVE,
    Math.max(
      MIN_FUNCTION_SAFETY_RESERVE,
      Math.floor(measuredAvailableTokens * FUNCTION_SAFETY_RESERVE_FRACTION)
    )
  )
}

function normalizeRequestedMaxTokens(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined
  return Math.max(1, Math.floor(value))
}
