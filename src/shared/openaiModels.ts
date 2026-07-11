/** Curated list of OpenAI models offered in the ChatGPT/Codex provider settings. */

export interface OpenAiModelOption {
  id: string
  label: string
  description: string
  /**
   * Conservative context-window estimate used to bound history sent to this
   * model (see `contextAssembler.ts`'s `boundHistoryForCloudProvider`) —
   * deliberately not the marketing-max figure, since Anodex has no exact
   * tokenizer for cloud models and estimates tokens from character count.
   */
  contextWindowTokens: number
}

export const OPENAI_MODELS: OpenAiModelOption[] = [
  {
    id: 'gpt-5.6',
    label: 'GPT-5.6',
    description: 'Frontier model — best for hard, complex professional work.',
    contextWindowTokens: 256_000
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    description: 'Balances intelligence and cost for everyday coding and chat.',
    contextWindowTokens: 256_000
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    description: 'Fastest and cheapest — good for quick, simple tasks.',
    contextWindowTokens: 128_000
  },
  {
    id: 'gpt-5.1-codex',
    label: 'GPT-5.1 Codex',
    description: 'Codex — tuned specifically for agentic coding tasks.',
    contextWindowTokens: 256_000
  }
]

export const DEFAULT_OPENAI_MODEL = 'gpt-5.6'
