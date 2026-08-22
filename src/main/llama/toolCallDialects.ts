import { buildDeepSeekChatWrapper } from './deepSeekWrapper'

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
}

const DEEPSEEK: ToolCallDialect = {
  name: 'deepseek',
  matches: (architecture) => architecture.startsWith('deepseek'),
  withTemplate: (nlc, template) => buildDeepSeekChatWrapper(nlc, template),
  withoutTemplate: (nlc) => new nlc.DeepSeekChatWrapper()
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
