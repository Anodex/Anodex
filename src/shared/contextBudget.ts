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

export const RESERVED_NON_HISTORY_FRACTION = 0.2
export const MIN_RESERVED_NON_HISTORY_TOKENS = 512
export const MAX_RESERVED_NON_HISTORY_TOKENS = 8192

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

/** Non-history token reservation for the given context window. */
export function reservedNonHistoryTokens(contextSize: number): number {
  return Math.min(
    MAX_RESERVED_NON_HISTORY_TOKENS,
    Math.max(
      MIN_RESERVED_NON_HISTORY_TOKENS,
      Math.round(contextSize * RESERVED_NON_HISTORY_FRACTION)
    )
  )
}

/* ------------------------------------------------------------------------ *
 * Per-budget allocation
 *
 * `reservedNonHistoryTokens` above already sets the shape every budget here
 * follows — a fraction of the window, floored and ceilinged — but it answers
 * one coarse question: how much is not history. It does not say how that room
 * is divided, and the pieces it covers were each sized independently, some of
 * them as fixed character counts that do not scale at all.
 *
 * A measured run showed what that costs. At a 16,384-token window the real
 * fixed overhead reached 12,548 tokens — 79% of the window, nearly four times
 * the 20% this module reserves — leaving about 3,300 tokens for the task. The
 * reservation was never wrong; nothing was accountable to it.
 *
 * Anodex now runs from 2,048 tokens on a laptop to 1,048,576 on a workstation
 * with half a terabyte of unified memory. That is nine doublings, and a
 * constant that suits either end is wrong at the other — which is also why the
 * published agents' numbers cannot simply be copied: OpenCode's *safety buffer*
 * alone is 20,000 tokens, larger than the entire window measured above.
 *
 * NOT YET WIRED. These budgets are declared and tested here first, deliberately
 * without changing what any of the ten current importers do. Moving the
 * assembler and both local transports onto them is the following step, and it
 * has to reconcile with `reservedNonHistoryTokens` rather than run beside it —
 * two overlapping budget authorities is precisely the seam that produces the
 * bugs this work exists to remove.
 * ------------------------------------------------------------------------ */

/** A fraction of the window, bounded at both ends. All values are tokens. */
interface BudgetRule {
  fraction: number
  floor: number
  ceiling: number
}

/**
 * Room held back for the model's own reply. The ceiling is low on purpose: no
 * single turn needs a 150,000-token answer, and reserving one would starve the
 * working set on exactly the machines that paid for the most memory.
 */
const OUTPUT_RESERVE: BudgetRule = { fraction: 0.15, floor: 512, ceiling: 4096 }

/**
 * System prompt plus the workspace tree, project notes, spec and memory — the
 * budget whose pieces are currently fixed character counts.
 */
const REFERENCE_CONTEXT: BudgetRule = { fraction: 0.15, floor: 1024, ceiling: 8192 }

/** JSON schemas of the exposed tools. */
const TOOL_SCHEMAS: BudgetRule = { fraction: 0.12, floor: 768, ceiling: 6144 }

/**
 * A ranked map of the repository. Floor of zero is deliberate: on a very small
 * window there is no map worth having, and a stub would cost room the working
 * set needs more.
 */
const REPO_MAP: BudgetRule = { fraction: 0.06, floor: 0, ceiling: 4096 }

/**
 * The share of the window the working set keeps no matter what. Below roughly
 * 4,000 tokens the floors above would otherwise sum past the whole window and
 * leave the working set negative.
 */
export const MIN_WORKING_SET_FRACTION = 0.35

/**
 * Fractions of the input limit at which observation masking begins and at which
 * the turn hands off to a fresh context epoch. Context degrades well before the
 * hard limit, so both fire early, and proportionally rather than at a constant.
 */
export const MASK_AT_FRACTION = 0.6
export const ROTATE_AT_FRACTION = 0.8

export interface ContextBudgetAllocation {
  contextSize: number
  /** Held back for the reply. */
  outputReserve: number
  /** System prompt, workspace tree, notes, spec, memory. */
  referenceContext: number
  /** Tool JSON schemas. */
  toolSchemas: number
  /** Ranked repository map. */
  repoMap: number
  /** Everything left for conversation and tool results. */
  workingSet: number
  /** Begin masking old observations once the prompt passes this. */
  maskAtTokens: number
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
    toolSchemas: applyRule(TOOL_SCHEMAS, size),
    repoMap: applyRule(REPO_MAP, size)
  }

  const overhead = raw.outputReserve + raw.referenceContext + raw.toolSchemas + raw.repoMap
  const overheadCeiling = Math.floor(size * (1 - MIN_WORKING_SET_FRACTION))
  const constrained = overhead > overheadCeiling

  // Scale every budget by the same factor rather than sacrificing one outright.
  // Zeroing the repo map first would be a false economy — it is the smallest
  // share, so it buys almost nothing, and the window that needs the scaling is
  // the one that can least afford to lose its orientation entirely.
  const scale = constrained && overhead > 0 ? overheadCeiling / overhead : 1
  const scaled = {
    outputReserve: Math.floor(raw.outputReserve * scale),
    referenceContext: Math.floor(raw.referenceContext * scale),
    toolSchemas: Math.floor(raw.toolSchemas * scale),
    repoMap: Math.floor(raw.repoMap * scale)
  }

  const usedOverhead =
    scaled.outputReserve + scaled.referenceContext + scaled.toolSchemas + scaled.repoMap
  const inputLimit = Math.max(0, size - scaled.outputReserve)

  return {
    contextSize: size,
    ...scaled,
    workingSet: Math.max(0, size - usedOverhead),
    maskAtTokens: Math.floor(inputLimit * MASK_AT_FRACTION),
    rotateAtTokens: Math.floor(inputLimit * ROTATE_AT_FRACTION),
    constrained
  }
}

/** The working set as a share of the window, for display and for tests. */
export function workingSetFraction(allocation: ContextBudgetAllocation): number {
  return allocation.contextSize === 0 ? 0 : allocation.workingSet / allocation.contextSize
}
