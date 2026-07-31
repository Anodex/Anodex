/**
 * Shared shape for a curated cloud model catalog entry — reused by every
 * provider's model list (`xaiModels.ts`, `deepseekModels.ts`, etc.) so the
 * identical shape isn't redeclared per provider. Anthropic/OpenAI keep their
 * own pre-existing `AnthropicModelOption`/`OpenAiModelOption` names rather
 * than migrating to this one, since nothing depends on them being distinct
 * and there's no need to churn working code.
 */
export interface CloudModelOption {
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
