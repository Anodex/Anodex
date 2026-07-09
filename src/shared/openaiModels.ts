/** Curated list of OpenAI models offered in the ChatGPT/Codex provider settings. */

export interface OpenAiModelOption {
  id: string
  label: string
  description: string
}

export const OPENAI_MODELS: OpenAiModelOption[] = [
  {
    id: 'gpt-5.6',
    label: 'GPT-5.6',
    description: 'Frontier model — best for hard, complex professional work.'
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    description: 'Balances intelligence and cost for everyday coding and chat.'
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    description: 'Fastest and cheapest — good for quick, simple tasks.'
  },
  {
    id: 'gpt-5.1-codex',
    label: 'GPT-5.1 Codex',
    description: 'Codex — tuned specifically for agentic coding tasks.'
  }
]

export const DEFAULT_OPENAI_MODEL = 'gpt-5.6'
