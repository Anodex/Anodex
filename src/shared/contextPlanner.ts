import {
  MIN_WORKING_SET_FRACTION,
  allocateContextBudget,
  automaticReferenceContextChars
} from './contextBudget'
import { APPROX_CHARS_PER_TOKEN } from './contextProjection'

/**
 * Which context-assembly strategy a generation runs.
 *
 * `current` is the shipped default and the immediate rollback path.
 * `adaptive-v1` changes one thing only: how *automatic* supporting material
 * (workspace orientation, remembered facts, past-chat recall) shares a single
 * measured allowance. Explicit user instructions, enabled tools, model choice
 * and the canonical transcript are outside this selector by design — see
 * `docs/CONTEXT_OS_HANDOFF.md`.
 */
export const CONTEXT_ASSEMBLY_STRATEGIES = ['current', 'adaptive-v1'] as const

export type ContextAssemblyStrategy = (typeof CONTEXT_ASSEMBLY_STRATEGIES)[number]

export function isContextAssemblyStrategy(value: unknown): value is ContextAssemblyStrategy {
  return typeof value === 'string' && CONTEXT_ASSEMBLY_STRATEGIES.includes(value as never)
}

export function normalizeContextAssemblyStrategy(value: unknown): ContextAssemblyStrategy {
  return isContextAssemblyStrategy(value) ? value : 'current'
}

export type AutomaticReferenceSourceId = 'workspace' | 'memory' | 'transcript-recall'

/**
 * One automatic reference source, already rendered by whichever retriever owns
 * its relevance decision.
 *
 * `units` are **indivisible** and ranked most-relevant first. That is the whole
 * contract: every retriever here already builds its output from ranked whole
 * pieces — one memory entry, one past conversation's excerpts, the workspace
 * summary — and cutting one in half produces text that reads as a fact while
 * missing the half that made it true. This packer includes a unit or it does
 * not; it never truncates one.
 */
export interface AutomaticReferenceSource {
  id: AutomaticReferenceSourceId
  units: string[]
  /** Joined with this when the selected units are rendered. Defaults to a newline. */
  separator?: string
}

export interface ContextAssemblySourceReport {
  id: AutomaticReferenceSourceId
  availableUnits: number
  includedUnits: number
  availableChars: number
  includedChars: number
  omittedChars: number
  /**
   * `current` — unchanged projection; `allocated` — every unit fitted;
   * `partial` — the highest-ranked units fitted; `deferred` — the source had
   * material but no room for even one unit; `unavailable` — nothing to offer.
   */
  selection: 'current' | 'allocated' | 'partial' | 'deferred' | 'unavailable'
}

/**
 * What the window could actually afford this generation, in tokens.
 *
 * Recorded because a report saying "3,918 characters were included" is not
 * evidence of anything without the capacity that number was chosen against.
 */
export interface ContextCapacityReport {
  contextWindowTokens: number
  outputReserveTokens: number
  /** Measured cost of the prompt with no automatic reference material in it. */
  fixedPromptTokens: number
  /** Tool schemas the transport will render, or 0 when tools are off. */
  toolSchemaTokens: number
  /** Room held for conversation history and tool results — `MIN_WORKING_SET_FRACTION`. */
  historyFloorTokens: number
  /** The window's normal reference cap, before the capacity contract applied. */
  referenceCapChars: number
  /** Characters per token this plan assumed — see `PromptCalibration`. */
  charsPerToken: number
  /** True when that came from a transport's own count rather than the fixed approximation. */
  calibrated: boolean
  /**
   * The measurement offered by the previous generation, recorded whether or not
   * it was accepted. Without it, a report showing the fixed ratio cannot be told
   * apart from one where no transport ever reported a count — and those call for
   * opposite fixes.
   */
  offeredCalibration?: PromptCalibration
}

/**
 * Persistable, content-free account of how automatic supporting context was
 * assembled for one generation. Source bodies stay in their existing stores;
 * this records sizes, capacity and selection decisions only.
 */
export interface ContextAssemblyReport {
  strategy: ContextAssemblyStrategy
  /** Null means the runtime had no factual capacity to plan against. */
  contextWindowTokens: number | null
  /** Present only when `adaptive-v1` planned against a real capacity. */
  capacity?: ContextCapacityReport
  /** Null for the unchanged current strategy or an unresolved context size. */
  automaticReferenceBudgetChars: number | null
  automaticReferenceAvailableChars: number
  automaticReferenceIncludedChars: number
  automaticReferenceOmittedChars: number
  /** A fingerprinted derived history snapshot was ignored for this generation. */
  staleHistorySnapshot?: boolean
  sources: ContextAssemblySourceReport[]
}

export interface AutomaticReferenceAssembly {
  texts: Record<AutomaticReferenceSourceId, string | null>
  /**
   * How many of each source's ranked units reached the prompt. Callers slice
   * their own ranked arrays by this so the provenance the UI shows is what the
   * model was actually given, not what the retriever offered.
   */
  includedUnits: Record<AutomaticReferenceSourceId, number>
  report: ContextAssemblyReport
}

/**
 * Order in which unused allowance is handed back.
 *
 * Workspace first because it is the only source that routinely wants more than
 * an equal share, and the orientation a task needs before it can act at all.
 * Recall last because it is the weakest signal of the three — lexical matches
 * from other conversations, which may have nothing to do with this request.
 */
const REDISTRIBUTION_ORDER: AutomaticReferenceSourceId[] = [
  'workspace',
  'memory',
  'transcript-recall'
]

const DEFAULT_SEPARATOR = '\n'

/**
 * How many characters of prompt one token holds, measured rather than assumed.
 *
 * `APPROX_CHARS_PER_TOKEN` is 4, which is right for English prose and wrong for
 * the system prompt, where structured instructions, punctuation, tool names and
 * paths tokenize far more densely. A measured 8K batch put the real figure at
 * **3.08** for the rendered system prompt: 7,794 characters that the engine
 * counted as 2,533 tokens, against the 1,949 the fixed ratio predicted. That
 * 584-token error was two thirds of why the capacity contract never bound.
 *
 * A transport that reports its own token count therefore gets to correct the
 * estimate — see `PromptCalibration`. The fixed ratio remains the fallback for
 * the first generation of a conversation, where nothing has been measured yet.
 */
export interface PromptCalibration {
  /** Characters of system prompt the last generation rendered. */
  chars: number
  /** Tokens the transport actually counted for them. */
  tokens: number
}

/**
 * Characters per token to plan with: the measured ratio when a transport has
 * reported one, otherwise the conservative fixed approximation.
 *
 * Guarded rather than trusted outright — a degenerate report (no characters, no
 * tokens, or a ratio outside what any tokenizer produces) falls back instead of
 * scaling the whole budget by a bad number.
 */
export function charsPerToken(calibration?: PromptCalibration | null): number {
  if (!calibration || calibration.chars <= 0 || calibration.tokens <= 0) {
    return APPROX_CHARS_PER_TOKEN
  }
  const ratio = calibration.chars / calibration.tokens
  return ratio >= 1 && ratio <= APPROX_CHARS_PER_TOKEN ? ratio : APPROX_CHARS_PER_TOKEN
}

/**
 * The one automatic-reference allowance for this generation, in characters.
 *
 * This is the capacity contract. Everything that is not automatic reference
 * material comes off the real window first — the reply reserve, the measured
 * fixed prompt, the tool schemas, and the room history and tool results need —
 * and whatever survives, capped by the window's normal reference ceiling, is
 * all the automatic sources get to share.
 *
 * The direction matters: this can only ever *shrink* the existing allowance,
 * never grow it. On a window with room the cap binds and nothing changes. On a
 * window whose fixed cost already fills it the result is zero, and the sources
 * report contributing nothing rather than quietly overcommitting a prompt the
 * reply then has no room in — the 4K failure recorded in
 * `docs/CONTEXT_OS_HANDOFF.md`.
 */
export function automaticReferenceAllowanceChars(input: {
  contextWindowTokens: number
  fixedPromptTokens: number
  toolSchemaTokens: number
  /** Measured characters-per-token, when a transport has reported one. */
  calibration?: PromptCalibration | null
}): number {
  const allocation = allocateContextBudget(input.contextWindowTokens)
  const historyFloor = Math.floor(input.contextWindowTokens * MIN_WORKING_SET_FRACTION)
  const spare =
    input.contextWindowTokens -
    allocation.outputReserve -
    input.fixedPromptTokens -
    input.toolSchemaTokens -
    historyFloor
  const cap = automaticReferenceContextChars(input.contextWindowTokens)
  // The same ratio on both sides: the spare tokens are converted into the
  // characters this material will actually cost, not into prose-sized ones.
  return Math.max(0, Math.min(cap, spare * charsPerToken(input.calibration)))
}

/** The capacity record behind an allowance, for the generation's report. */
export function capacityReport(input: {
  contextWindowTokens: number
  fixedPromptTokens: number
  toolSchemaTokens: number
  calibration?: PromptCalibration | null
}): ContextCapacityReport {
  return {
    contextWindowTokens: input.contextWindowTokens,
    outputReserveTokens: allocateContextBudget(input.contextWindowTokens).outputReserve,
    fixedPromptTokens: input.fixedPromptTokens,
    toolSchemaTokens: input.toolSchemaTokens,
    historyFloorTokens: Math.floor(input.contextWindowTokens * MIN_WORKING_SET_FRACTION),
    referenceCapChars: automaticReferenceContextChars(input.contextWindowTokens),
    charsPerToken: Number(charsPerToken(input.calibration).toFixed(2)),
    calibrated: charsPerToken(input.calibration) !== APPROX_CHARS_PER_TOKEN,
    ...(input.calibration ? { offeredCalibration: input.calibration } : {})
  }
}

/**
 * Build the automatic reference portion of the system prompt.
 *
 * The existing retrieval services decide what is *relevant*. This decides only
 * how much of what they selected the window can afford, by giving every
 * automatic source one shared allowance instead of three independent ones —
 * which is what let transcript recall become a third, unbudgeted prompt segment.
 *
 * Sources that have material start with an equal share. Equal rather than
 * tuned: nothing about a request says in advance which of the three carries the
 * fact that matters, and a fixed split would be a constant fitted to whichever
 * chat it was measured on. A source that cannot use its share hands the
 * remainder back in `REDISTRIBUTION_ORDER`, so the split lands where the
 * material actually is.
 */
export function assembleAutomaticReferenceContext(input: {
  strategy: ContextAssemblyStrategy
  contextWindowTokens: number | undefined
  /** Measured prompt cost with no automatic reference material — required by `adaptive-v1`. */
  fixedPromptTokens?: number
  /** Tool-schema cost the transport will render — required by `adaptive-v1`. */
  toolSchemaTokens?: number
  /** A transport's own count of a prompt it rendered, to correct the token estimate. */
  calibration?: PromptCalibration | null
  sources: AutomaticReferenceSource[]
}): AutomaticReferenceAssembly {
  const sources = new Map<AutomaticReferenceSourceId, AutomaticReferenceSource>(
    REDISTRIBUTION_ORDER.map((id) => [id, { id, units: [] }])
  )
  for (const source of input.sources) {
    // Empty units are dropped; the rest are passed through byte-for-byte. Not
    // trimmed: `current` has to render exactly what it rendered before this
    // packer existed, or it is not the rollback path it is documented as.
    sources.set(source.id, { ...source, units: source.units.filter((unit) => unit.trim()) })
  }

  const contextWindowTokens = input.contextWindowTokens
  if (input.strategy !== 'adaptive-v1' || !contextWindowTokens || contextWindowTokens <= 0) {
    return unchangedProjection(input.strategy, contextWindowTokens, sources)
  }

  const capacityInput = {
    contextWindowTokens,
    fixedPromptTokens: Math.max(0, input.fixedPromptTokens ?? 0),
    toolSchemaTokens: Math.max(0, input.toolSchemaTokens ?? 0),
    calibration: input.calibration
  }
  const allowance = automaticReferenceAllowanceChars(capacityInput)
  const packed = packSources(sources, allowance)

  const texts = mapSources((id) => {
    const source = sources.get(id)!
    const selected = source.units.slice(0, packed[id].units)
    return selected.length > 0 ? selected.join(separatorOf(source)) : null
  })
  const available = mapSources((id) => renderedLength(sources.get(id)!))
  const included = mapSources((id) => texts[id]?.length ?? 0)

  return {
    texts,
    includedUnits: mapSources((id) => packed[id].units),
    report: {
      strategy: input.strategy,
      contextWindowTokens,
      capacity: capacityReport(capacityInput),
      automaticReferenceBudgetChars: allowance,
      automaticReferenceAvailableChars: sum(available),
      automaticReferenceIncludedChars: sum(included),
      automaticReferenceOmittedChars: sum(
        mapSources((id) => Math.max(0, available[id] - included[id]))
      ),
      sources: REDISTRIBUTION_ORDER.map((id) => ({
        id,
        availableUnits: sources.get(id)!.units.length,
        includedUnits: packed[id].units,
        availableChars: available[id],
        includedChars: included[id],
        omittedChars: Math.max(0, available[id] - included[id]),
        selection: selectionOf(sources.get(id)!.units.length, packed[id].units)
      }))
    }
  }
}

/**
 * The unchanged path: every source passes through exactly as its retriever
 * built it. Used by `current`, and by `adaptive-v1` when no model is loaded and
 * there is therefore no factual capacity to plan against — guessing one there
 * would shrink real context on the strength of a number nobody measured.
 */
function unchangedProjection(
  strategy: ContextAssemblyStrategy,
  contextWindowTokens: number | undefined,
  sources: Map<AutomaticReferenceSourceId, AutomaticReferenceSource>
): AutomaticReferenceAssembly {
  const texts = mapSources((id) => {
    const source = sources.get(id)!
    return source.units.length > 0 ? source.units.join(separatorOf(source)) : null
  })
  const total = sum(mapSources((id) => texts[id]?.length ?? 0))
  return {
    texts,
    includedUnits: mapSources((id) => sources.get(id)!.units.length),
    report: {
      strategy,
      contextWindowTokens: contextWindowTokens ?? null,
      automaticReferenceBudgetChars: null,
      automaticReferenceAvailableChars: total,
      automaticReferenceIncludedChars: total,
      automaticReferenceOmittedChars: 0,
      sources: REDISTRIBUTION_ORDER.map((id) => {
        const units = sources.get(id)!.units.length
        const chars = texts[id]?.length ?? 0
        return {
          id,
          availableUnits: units,
          includedUnits: units,
          availableChars: chars,
          includedChars: chars,
          omittedChars: 0,
          selection: units > 0 ? ('current' as const) : ('unavailable' as const)
        }
      })
    }
  }
}

interface PackedSource {
  units: number
  chars: number
}

/**
 * Equal shares first, then hand the remainder back in priority order.
 *
 * Two passes rather than one greedy sweep: a single sweep in priority order
 * would let the workspace summary spend the whole allowance before memory or
 * recall were considered at all, which is the all-or-nothing behaviour this
 * packer exists to end.
 */
function packSources(
  sources: Map<AutomaticReferenceSourceId, AutomaticReferenceSource>,
  allowance: number
): Record<AutomaticReferenceSourceId, PackedSource> {
  const packed = mapSources(() => ({ units: 0, chars: 0 }))
  const active = REDISTRIBUTION_ORDER.filter((id) => sources.get(id)!.units.length > 0)
  if (active.length === 0 || allowance <= 0) return packed

  const share = Math.floor(allowance / active.length)
  for (const id of active) extend(packed[id], sources.get(id)!, share)

  let remaining = allowance - sum(mapSources((id) => packed[id].chars))
  for (const id of REDISTRIBUTION_ORDER) {
    if (remaining <= 0) break
    const before = packed[id].chars
    extend(packed[id], sources.get(id)!, before + remaining)
    remaining -= packed[id].chars - before
  }
  return packed
}

/**
 * Take whole ranked units while they fit, stopping at the first that does not.
 *
 * Stopping rather than skipping ahead to a smaller lower-ranked unit: the order
 * is the retriever's relevance judgement, and filling a hole with something it
 * ranked lower makes what reaches the model depend on the size of what came
 * before it.
 */
function extend(packed: PackedSource, source: AutomaticReferenceSource, limit: number): void {
  const separator = separatorOf(source).length
  for (let index = packed.units; index < source.units.length; index++) {
    const cost = source.units[index].length + (packed.units === 0 ? 0 : separator)
    if (packed.chars + cost > limit) return
    packed.chars += cost
    packed.units++
  }
}

function selectionOf(
  available: number,
  included: number
): ContextAssemblySourceReport['selection'] {
  if (available === 0) return 'unavailable'
  if (included === 0) return 'deferred'
  return included >= available ? 'allocated' : 'partial'
}

function separatorOf(source: AutomaticReferenceSource): string {
  return source.separator ?? DEFAULT_SEPARATOR
}

/** Rendered size of every unit a source offered, separators included. */
function renderedLength(source: AutomaticReferenceSource): number {
  return source.units.length === 0 ? 0 : source.units.join(separatorOf(source)).length
}

function mapSources<T>(
  build: (id: AutomaticReferenceSourceId) => T
): Record<AutomaticReferenceSourceId, T> {
  return Object.fromEntries(REDISTRIBUTION_ORDER.map((id) => [id, build(id)])) as Record<
    AutomaticReferenceSourceId,
    T
  >
}

function sum(values: Record<AutomaticReferenceSourceId, number>): number {
  return REDISTRIBUTION_ORDER.reduce((total, id) => total + values[id], 0)
}
