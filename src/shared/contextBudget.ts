import type { CloudModelOption } from './cloudModelOption'
import { ANTHROPIC_MODELS } from './anthropicModels'
import { OPENAI_MODELS } from './openaiModels'
import { GOOGLE_MODELS } from './googleModels'
import { XAI_MODELS } from './xaiModels'
import { DEEPSEEK_MODELS } from './deepseekModels'
import { MISTRAL_MODELS } from './mistralModels'
import { GROQ_MODELS } from './groqModels'
import { OPENROUTER_MODELS } from './openrouterModels'
import { KIMI_MODELS } from './kimiModels'
import { QWEN_MODELS } from './qwenModels'

/**
 * Shared context-budget knobs used by both the main-process assembler and the
 * renderer's projected context meter.
 *
 * These values describe Anodex's model-facing projection, not the persisted
 * chat transcript. Keeping them shared prevents the UI from displaying a
 * different context story than the engine actually uses.
 */

/**
 * Manual compaction keeps this many newest turns verbatim. The summary covers
 * everything older, so the user can clean the context before a new phase
 * without sacrificing the immediate back-and-forth that often contains
 * unresolved details.
 */
export const MANUAL_COMPACTION_RECENT_TURNS = 6

/**
 * Fraction of the history budget the balanced Context Ledger policy may replay verbatim.
 *
 * The retired greedy policy let history fill the whole budget, so a rebuilt
 * session sat near the compaction trigger with almost no room to refill. The
 * balanced policy caps replay at this fraction: older turns are summarized
 * instead of replayed, the rebuilt KV cache starts low, and the meter resets
 * refills turn by turn — the opencode-style context-epoch behaviour. Shared so
 * the engine and the renderer's projection meter can never disagree about what
 * the replay ceiling is.
 *
 * `null` (in settings) means no cap — the historical greedy behaviour.
 */
export const DEFAULT_RECALL_WINDOW_FRACTION = 0.4

/**
 * Maximum remembered output per past tool call when rebuilding model context.
 * Full tool details can remain in the UI transcript; this is the compact
 * model-facing replay limit.
 */
export const MAX_MODEL_TOOL_RESULT_CHARS = 1_200

/**
 * Conservative context-window fallback for a cloud model with no known
 * `contextWindowTokens` entry (e.g. a custom/typed-in model override). Well
 * below every current OpenAI/Anthropic model's real window so an unrecognized
 * model still gets bounded instead of replaying history unboundedly.
 */
export const DEFAULT_CLOUD_CONTEXT_WINDOW_TOKENS = 128_000

/** Every non-local provider `cloudContextWindowTokens` can look up a catalog for. */
export type CloudProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'deepseek'
  | 'mistral'
  | 'groq'
  | 'openrouter'
  | 'azure'
  | 'kimi'
  | 'qwen'

/**
 * `azure` deliberately maps to an empty catalog: Azure has no fixed model
 * catalog (a customer names their own deployment), so a lookup here always
 * falls through to `DEFAULT_CLOUD_CONTEXT_WINDOW_TOKENS` rather than being
 * a special case in `cloudContextWindowTokens` itself.
 */
const CLOUD_MODEL_CATALOGS: Record<CloudProvider, CloudModelOption[]> = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  google: GOOGLE_MODELS,
  xai: XAI_MODELS,
  deepseek: DEEPSEEK_MODELS,
  mistral: MISTRAL_MODELS,
  groq: GROQ_MODELS,
  openrouter: OPENROUTER_MODELS,
  azure: [],
  kimi: KIMI_MODELS,
  qwen: QWEN_MODELS
}

/** Conservative context window for a configured cloud model. */
export function cloudContextWindowTokens(provider: CloudProvider, modelId: string): number {
  const models = CLOUD_MODEL_CATALOGS[provider] ?? []
  return (
    models.find((model) => model.id === modelId)?.contextWindowTokens ??
    DEFAULT_CLOUD_CONTEXT_WINDOW_TOKENS
  )
}

/* ------------------------------------------------------------------------ *
 * Per-budget allocation
 *
 * Everything that is not conversation history — the reply, the reference
 * context, the tool schemas — is budgeted here, as a fraction of the window
 * with a floor and a ceiling. The fraction is what makes it scale; the floor
 * stops a small window allocating something too small to function; the ceiling
 * stops a huge window spending 150,000 tokens on a system prompt that has
 * nothing more to say.
 *
 * Anodex runs from 2,048 tokens on a laptop to 1,048,576 on a workstation with
 * half a terabyte of unified memory. That is nine doublings, and a constant
 * that suits either end is wrong at the other — which is also why the published
 * agents' numbers cannot be copied: OpenCode's *safety buffer* alone is 20,000
 * tokens, larger than the entire window of the run measured below.
 *
 * ## Why this replaced a flat 20% reservation
 *
 * `reservedNonHistoryTokens` used to be its own rule — 20% of the window,
 * floored at 512 and ceilinged at 8,192 — sized independently of the things it
 * was meant to cover. A measured run showed the cost: at a 16,384-token window
 * the real fixed overhead reached 12,548 tokens, 79% of the window, nearly four
 * times what was reserved for it, leaving about 3,300 tokens for the task. The
 * reservation was not wrong so much as unenforced — nothing was accountable to
 * it, so the assembler planned history against room that did not exist.
 *
 * It is now derived from the same allocation the rest of the system uses, so
 * the number the meter shows and the number the prompt obeys cannot drift.
 * ------------------------------------------------------------------------ */

/** A fraction of the window, bounded at both ends. All values are tokens. */
interface BudgetRule {
  fraction: number
  floor: number
  ceiling: number
}

/**
 * Room held back for the model's own reply. The ceiling matters: no single turn
 * needs a 150,000-token answer, and reserving one would starve the working set
 * on exactly the machines that paid for the most memory. 8,192 is generous
 * enough for a long reasoning reply and is what the flat rule this replaced
 * capped at, so the top of the range is unchanged.
 */
const OUTPUT_RESERVE: BudgetRule = { fraction: 0.15, floor: 512, ceiling: 8192 }

/**
 * The workspace tree, project notes, spec and memory that open the system
 * prompt. A planning budget, not a second reservation: the assembler measures
 * the rendered prompt and subtracts the real count. This caps what goes into
 * it — see `referenceContextChars`.
 */
const REFERENCE_CONTEXT: BudgetRule = { fraction: 0.15, floor: 1024, ceiling: 8192 }

/**
 * JSON schemas of the exposed tools. Also a planning budget — it decides how
 * many tools are worth exposing on a given window, while the assembler
 * subtracts the schemas actually rendered.
 */
const TOOL_SCHEMAS: BudgetRule = { fraction: 0.12, floor: 768, ceiling: 6144 }

/**
 * The share of the window the working set keeps no matter what. Below roughly
 * 4,000 tokens the floors above would otherwise sum past the whole window and
 * leave the working set negative.
 */
export const MIN_WORKING_SET_FRACTION = 0.35

/**
 * The fraction of the input limit at which the turn hands off to a fresh
 * context epoch. Context degrades well before the hard limit, so this fires
 * early, and proportionally rather than at a constant.
 *
 * There was a `MASK_AT_FRACTION = 0.6` beside this, and a `maskAtTokens` in
 * every allocation, for an observation-masking pass that was never built. Both
 * were removed rather than left computed: this file's own comments describe
 * having once shipped a budget nothing enforced, and the doc on the field
 * asserted that masking happened. The threshold and its reasoning are recorded
 * in `docs/ANODEX_DEFERRED_BUGS.md` for whoever implements it.
 */
export const ROTATE_AT_FRACTION = 0.8

export interface ContextBudgetAllocation {
  contextSize: number
  /** Held back for the reply. */
  outputReserve: number
  /** System prompt, workspace tree, notes, spec, memory. */
  referenceContext: number
  /** Tool JSON schemas. */
  toolSchemas: number
  /** Everything left for conversation and tool results. */
  workingSet: number
  /** Hand off to a fresh epoch once the prompt passes this. */
  rotateAtTokens: number
  /** True when floors were scaled back because the window could not fit them. */
  constrained: boolean
}

function applyRule(rule: BudgetRule, contextSize: number): number {
  return Math.floor(Math.min(Math.max(rule.fraction * contextSize, rule.floor), rule.ceiling))
}

/**
 * Divide a context window into its budgets.
 *
 * Deliberately a pure function of one number, for the same reason the constants
 * above are shared: the renderer displays this split and the engine enforces
 * it, and any disagreement shows up as the meter telling the user one story
 * while the prompt follows another.
 */
export function allocateContextBudget(contextSize: number): ContextBudgetAllocation {
  const size = Math.max(0, Math.floor(contextSize))

  const raw = {
    outputReserve: applyRule(OUTPUT_RESERVE, size),
    referenceContext: applyRule(REFERENCE_CONTEXT, size),
    toolSchemas: applyRule(TOOL_SCHEMAS, size)
  }

  const overheadCeiling = Math.floor(size * (1 - MIN_WORKING_SET_FRACTION))
  const overhead = raw.outputReserve + raw.referenceContext + raw.toolSchemas
  const constrained = overhead > overheadCeiling

  // When the floors do not fit, they are not squeezed equally. The reply is
  // protected first: a turn with no room to answer produces nothing at all,
  // while a thinner workspace summary or a smaller tool surface still leaves a
  // working system. So the output reserve takes its floor, and the two planning
  // budgets share whatever is left in proportion to each other.
  const outputReserve = Math.min(raw.outputReserve, overheadCeiling)
  const remaining = Math.max(0, overheadCeiling - outputReserve)
  const soft = raw.referenceContext + raw.toolSchemas
  const scale = constrained && soft > remaining && soft > 0 ? remaining / soft : 1
  const scaled = {
    outputReserve,
    referenceContext: Math.floor(raw.referenceContext * scale),
    toolSchemas: Math.floor(raw.toolSchemas * scale)
  }

  const usedOverhead = scaled.outputReserve + scaled.referenceContext + scaled.toolSchemas
  const inputLimit = Math.max(0, size - scaled.outputReserve)

  return {
    contextSize: size,
    ...scaled,
    workingSet: Math.max(0, size - usedOverhead),
    rotateAtTokens: Math.floor(inputLimit * ROTATE_AT_FRACTION),
    constrained
  }
}

/**
 * Tokens held back from the history budget on top of what the caller measures.
 *
 * This is the reply, and only the reply. `historyBudgetTokens` already
 * subtracts the *measured* system prompt and the *measured* tool schemas, so
 * adding the reference-context and tool-schema budgets here would charge for
 * both twice — the double-count that makes a small window look like it has no
 * room for history at all. Those two budgets exist to cap what gets built in
 * the first place, not to be subtracted a second time after it has been.
 *
 * Four call sites ask this question — the assembler, the compactor, the text
 * transport and the renderer's meter — and all four must agree, which is why it
 * reads from the allocation rather than carrying a rule of its own.
 */
export function reservedNonHistoryTokens(contextSize: number): number {
  return allocateContextBudget(contextSize).outputReserve
}

/**
 * Roughly four characters per token for English prose and source code.
 *
 * Only ever used to turn a token budget into a character cap for text Anodex
 * truncates itself, where being a little conservative costs a few characters
 * and being optimistic costs an overflow.
 */
const CHARS_PER_TOKEN = 4

/**
 * Character budget for the workspace summary that opens the system prompt.
 *
 * The summary's own limits are what it takes to be *useful*; this is what the
 * window can *afford*. Taking the smaller of the two means a large window is
 * unaffected — there is no more workspace worth describing — while a small one
 * stops spending a fifth of itself on a preamble before the task even starts.
 */
export function referenceContextChars(contextSize: number): number {
  return allocateContextBudget(contextSize).referenceContext * CHARS_PER_TOKEN
}

/**
 * What the reference sections total when the window can afford all of them:
 * the workspace summary (tree, notes, spec) plus the retrieved memory section.
 *
 * They are budgeted against one number because they share one budget. Sized
 * separately, each would assume the whole reference allowance was its own and
 * together they would spend it twice.
 */
export const FULL_REFERENCE_CONTEXT_CHARS = 5100

/**
 * Total character allowance for automatic supporting material in adaptive-v1.
 *
 * Workspace orientation, remembered facts, and past-chat excerpts all share
 * this allowance. The old full-size value already reflects the amount of
 * reference material Anodex found useful in a normal prompt; transcript recall
 * now competes for it instead of becoming a third, unaccounted prompt segment.
 */
export function automaticReferenceContextChars(contextSize: number): number {
  return Math.min(referenceContextChars(contextSize), FULL_REFERENCE_CONTEXT_CHARS)
}

/**
 * How much of its full size each reference section may use on this window,
 * from 0 to 1. Above roughly 16k this is 1 — there is no more workspace or
 * memory worth describing, so a bigger window simply spends less of itself on
 * the preamble.
 */
export function referenceContextShare(contextSize: number): number {
  return Math.min(1, referenceContextChars(contextSize) / FULL_REFERENCE_CONTEXT_CHARS)
}

/** The working set as a share of the window, for display and for tests. */
export function workingSetFraction(allocation: ContextBudgetAllocation): number {
  return allocation.contextSize === 0 ? 0 : allocation.workingSet / allocation.contextSize
}

/**
 * How many tokens the resident tool surface and system prompt may occupy.
 *
 * This is what `boundToolSurface` measures each candidate tool against: below
 * it, a tool stays natively described; above it, the rest go behind the
 * find/describe/call gateway.
 *
 * ## Why it reads from the allocation
 *
 * `LlamaService` used to compute this itself as "the window, minus a context
 * shift reserve, minus the output reserve, minus a tool-result headroom". That
 * subtracts three things and reserves nothing at all for the conversation, so
 * the tool surface was permitted to grow into the room history needed. On an
 * 8,192-token window it allowed 4,917 tokens — sixty percent of the context —
 * for fixed cost alone.
 *
 * Measured consequence: an email conversation at 8K, where the mailbox tools
 * make the surface large, reached `fixedTokens: 4096` and then died. Turn two
 * took 879 seconds; turn three returned zero characters with
 * `stop=context-shift-limit`, which is an empty reply in the UI. Every model
 * tested failed the same way, including the 27B that scores 10/10 on the chat
 * matrix at the same window — so this was never a weak-model problem.
 *
 * The allocation already partitions the window exactly: `outputReserve` for the
 * reply, `referenceContext` for the system prompt and its sections,
 * `toolSchemas` for the schemas, and `workingSet` for conversation and tool
 * results. The first two are precisely the fixed cost, so that is what this
 * returns — and the working set stops being collateral. The old arithmetic also
 * double-counted, subtracting a tool-result headroom that `workingSet` already
 * covers; `reservedNonHistoryTokens` warns about exactly that mistake a few
 * functions above.
 */
export function toolSurfaceBudgetTokens(contextSize: number): number {
  const allocation = allocateContextBudget(contextSize)
  return allocation.referenceContext + allocation.toolSchemas
}
