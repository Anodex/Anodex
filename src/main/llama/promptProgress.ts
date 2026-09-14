import type { PromptReadingProgress } from '@shared/chat.types'

/**
 * llama-server's `prompt_progress` on a stream chunk, as how much of the prompt has
 * been read: cached tokens count as read, since the model does not read them again.
 */
export function promptProgressOf(chunk: unknown): PromptReadingProgress | null {
  const progress = (chunk as { prompt_progress?: unknown } | null)?.prompt_progress as
    { total?: unknown; cache?: unknown; processed?: unknown } | undefined
  if (!progress) return null
  const total = Number(progress.total)
  const cache = Number(progress.cache ?? 0)
  const processed = Number(progress.processed ?? 0)
  if (!Number.isFinite(total) || total <= 0) return null
  return { done: Math.min(total, Math.max(0, cache + processed)), total }
}
