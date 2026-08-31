import { buildDeepSeekChatWrapper } from './deepSeekWrapper'
import { DEEPSEEK_OUTPUTS_BEGIN, DEEPSEEK_OUTPUT_BEGIN } from '@shared/deepSeekMarkers'

type NlcModule = typeof import('node-llama-cpp')

/**
 * A model family whose tool-call syntax node-llama-cpp does not resolve
 * correctly on its own.
 *
 * node-llama-cpp already ships wrappers for most families and picks one from
 * the GGUF, so this table is deliberately an *exception* list rather than a
 * catalog: an entry earns its place only when a real model was observed
 * getting it wrong. Everything not listed here keeps the library's own
 * resolution, which is right far more often than a hand-written rule would be.
 *
 * Keyed on the GGUF's declared architecture rather than the file name, which a
 * user can rename. Narrower than the general rule against model-name special
 * cases: this picks the parse pattern a model was *trained* to emit, the same
 * kind of factual capability as pairing a vision projector, not a guess about
 * what the user meant.
 */
export interface ToolCallDialect {
  /** Human-readable name, for logs and tests. */
  readonly name: string
  /** True when this dialect describes the given `general.architecture`. */
  matches(architecture: string): boolean
  /**
   * Wrapper that keeps the model's own embedded Jinja template — the prompt it
   * was trained on — and teaches node-llama-cpp to read back the calls that
   * prompt produces.
   */
  withTemplate(nlc: NlcModule, template: string): object
  /**
   * Wrapper for a GGUF carrying no template at all, where the library's own
   * purpose-built wrapper (prompt included) is the best available.
   */
  withoutTemplate(nlc: NlcModule): object
  /**
   * Text that only the engine may legitimately produce — the markers that
   * introduce a tool *result*. A model writing one is inventing a result it was
   * never given, so generation is stopped there.
   */
  readonly fabricatedResultMarkers?: readonly string[]
}

const DEEPSEEK: ToolCallDialect = {
  name: 'deepseek',
  matches: (architecture) => architecture.startsWith('deepseek'),
  withTemplate: (nlc, template) => buildDeepSeekChatWrapper(nlc, template),
  withoutTemplate: (nlc) => new nlc.DeepSeekChatWrapper(),
  fabricatedResultMarkers: [DEEPSEEK_OUTPUTS_BEGIN, DEEPSEEK_OUTPUT_BEGIN]
}

const DIALECTS: readonly ToolCallDialect[] = [DEEPSEEK]

/**
 * The chat wrapper to use instead of the one node-llama-cpp resolves on its
 * own, or `undefined` to keep the library's choice.
 *
 * Substituting a purpose-built wrapper *wholesale* is not the answer when the
 * model has its own template: that replaces the prompt as well, and DeepSeek
 * then stopped attempting calls at all (47 tokens of stated intent, no call).
 * Keeping the model's template and teaching the wrapper its call syntax is
 * what fixes both halves — hence the two-branch shape of every dialect.
 */
export function resolveToolCallingWrapper(
  nlc: NlcModule,
  architecture: string | undefined,
  template: string | undefined
): object | undefined {
  if (typeof architecture !== 'string' || architecture.length === 0) return undefined

  const dialect = DIALECTS.find((candidate) => candidate.matches(architecture.toLowerCase()))
  if (!dialect) return undefined

  return typeof template === 'string' && template.length > 0
    ? dialect.withTemplate(nlc, template)
    : dialect.withoutTemplate(nlc)
}

/**
 * Stop triggers for the loaded model: text that, if the model writes it, means
 * it has stopped calling tools and started inventing their results.
 *
 * This is syntax, not intent. Anodex deliberately does not let a phrase match
 * drive orchestration — "does this reply claim a change that never happened"
 * is guesswork — but a tool-result marker is not a phrase. It is a token the
 * engine alone emits, and a model producing one has begun fabricating by
 * definition. Measured directly: given a three-step task,
 * DeepSeek-Coder-V2-Lite ran the first call, then wrote its own
 * `<｜tool▁output▁begin｜>` block containing invented file contents and
 * reasoned onward from them. Stopping at the marker ends that turn while it is
 * still only one wrong sentence long, instead of spending the whole budget
 * building on a fiction.
 */
/**
 * The one marker that belongs to no dialect, because Anodex writes it.
 *
 * `LlamaService` continues a fallback-parsed call by putting
 * `Tool result for <name>:` into the prompt. That text is the harness speaking,
 * so a model emitting it has started inventing results — the same argument as a
 * dialect's own tool-output token, and for a string every model can see.
 *
 * Measured: gemma-3-27b wrote it on 6 of 44 turns and reasoned onward from
 * invented file contents, claiming a `unittest` import and a `Product` class in
 * a fixture that has neither. Across 571 turns of five other models it never
 * appeared, so this costs nothing where it is not needed.
 */
const HARNESS_RESULT_MARKER = 'Tool result for '

export function fabricatedResultStopTriggers(architecture: string | undefined): string[] {
  if (typeof architecture !== 'string' || architecture.length === 0) return []
  const dialect = DIALECTS.find((candidate) => candidate.matches(architecture.toLowerCase()))
  return [HARNESS_RESULT_MARKER, ...(dialect?.fabricatedResultMarkers ?? [])]
}
