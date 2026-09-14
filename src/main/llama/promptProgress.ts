import type { PromptReadingProgress } from '@shared/chat.types'

/**
 * llama-server's `prompt_progress` on a stream chunk, as how much of the prompt has
 * been read.
 *
 * `processed` already counts the cached tokens: a request whose first 7,026 tokens
 * were cached opens with `cache: 7026, processed: 7026`. Adding the two, as this first
 * did, pushed every cached request past its total at once, so a long read after a
 * cached start never showed. `cache` is kept as a floor in case a build reports
 * `processed` without it.
 */
export function promptProgressOf(chunk: unknown): PromptReadingProgress | null {
  const progress = (chunk as { prompt_progress?: unknown } | null)?.prompt_progress as
    { total?: unknown; cache?: unknown; processed?: unknown } | undefined
  if (!progress) return null
  const total = Number(progress.total)
  const cache = Number(progress.cache ?? 0)
  const processed = Number(progress.processed ?? 0)
  if (!Number.isFinite(total) || total <= 0) return null
  const done = Math.max(
    Number.isFinite(cache) ? cache : 0,
    Number.isFinite(processed) ? processed : 0
  )
  return { done: Math.min(total, Math.max(0, done)), total }
}
