/**
 * Labels and context windows for OpenAI models Anodex knows about.
 *
 * No longer the list of what is *offered*: the pickers ask the key what it can
 * actually reach (see `useLiveCloudModels`), because a hardcoded list goes
 * stale. `gpt-5.1-codex` sat here after it stopped being served, so choosing it
 * failed the run with "404 Model not found" — it has been removed, and the
 * account this was found on in fact offers gpt-5.5, gpt-5.4-pro, gpt-5.3-codex
 * and a dozen more that were never in this file.
 *
 * What it is still for: a readable label, and the real `contextWindowTokens`
 * used to bound history. A discovered model absent from here is still offered,
 * on the conservative `DEFAULT_CLOUD_CONTEXT_WINDOW_TOKENS` — `models.list`
 * does not report context length, and guessing high truncates conversations.
 */

export interface OpenAiModelOption {
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
  }
]

export const DEFAULT_OPENAI_MODEL = 'gpt-5.6'
