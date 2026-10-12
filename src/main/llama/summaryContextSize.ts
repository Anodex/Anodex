/**
 * The side context's size: the most any background caller asks for (compaction
 * and email digests, at 4,096 tokens), however small the first caller is.
 *
 * It used to start at whatever the first caller asked for and be rebuilt when a
 * later one wanted more. Every reply asks for a title (1,536) and then a
 * suggestion (2,048), so it was rebuilt after almost every first reply, and on a
 * hybrid model such as Qwen3.8 that crashed the app. The engine resolves a prompt
 * before it has finished writing that sequence's checkpoint, so the rebuild freed
 * the sequence while the checkpoint was still reading it (SIGSEGV in
 * `llama_state_seq_get_data_ext`). Built once at full size, it is never freed
 * until the model is unloaded.
 */
export const SUMMARY_CONTEXT_TOKENS = 4096

export function summaryContextSize(needed: number): number {
  return Math.max(needed, SUMMARY_CONTEXT_TOKENS)
}
