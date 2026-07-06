import type { GenerateOutcome, GenerateParams } from '../llama/LlamaService'

/**
 * A backend capable of producing an assistant reply for a chat turn.
 *
 * `LlamaService` (the local node-llama-cpp engine) is the only implementation
 * today. This interface exists so a future cloud provider (OpenAI-compatible,
 * Anthropic, etc.) can be added by implementing it and registering with
 * {@link ProviderRegistry}, without changing `chat.handlers.ts` or the agent
 * workflow that calls it.
 */
export interface LlmProvider {
  /** Stable identifier, e.g. `'local'`. Matched against a future settings field. */
  id: string
  generate(params: GenerateParams): Promise<GenerateOutcome>
}
