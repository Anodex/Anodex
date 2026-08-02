/** Curated list of Claude models offered in the Anthropic provider settings. */

export interface AnthropicModelOption {
  id: string
  label: string
  description: string
  /**
   * Conservative context-window estimate used to bound history sent to this
   * model (see `contextAssembler.ts`'s `boundHistoryForStatelessProvider`) —
   * deliberately not the marketing-max figure, since Anodex has no exact
   * tokenizer for cloud models and estimates tokens from character count.
   */
  contextWindowTokens: number
}

export const ANTHROPIC_MODELS: AnthropicModelOption[] = [
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    description: 'Most capable — best for hard, long-horizon coding and agentic work.',
    contextWindowTokens: 200_000
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    description: 'Best balance of speed and intelligence for everyday coding and chat.',
    contextWindowTokens: 200_000
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    description: 'Fastest and cheapest — good for quick, simple tasks.',
    contextWindowTokens: 200_000
  }
]

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5'
