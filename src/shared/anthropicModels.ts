/** Curated list of Claude models offered in the Anthropic provider settings. */

export interface AnthropicModelOption {
  id: string
  label: string
  description: string
}

export const ANTHROPIC_MODELS: AnthropicModelOption[] = [
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    description: 'Most capable — best for hard, long-horizon coding and agentic work.'
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    description: 'Best balance of speed and intelligence for everyday coding and chat.'
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    description: 'Fastest and cheapest — good for quick, simple tasks.'
  }
]

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5'
