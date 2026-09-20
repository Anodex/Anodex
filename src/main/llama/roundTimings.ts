/**
 * llama-server's own account of what a round cost, read off the final stream
 * chunk.
 *
 * ## Why this exists
 *
 * "Why does typing Hello take so long" was, until this, unanswerable from the
 * log. Every round already logs how many tokens the prompt came to
 * (`reportedPromptTokens`), but a token count says nothing about where the
 * wait went — and on this transport the wait is almost entirely one thing:
 * whether llama-server had to read the prompt again or found it already in its
 * cache. Measured on an RX 7900 XTX running Qwen3.8-27B-Q4_K_M, the same
 * 4,785-token chat request took **6,817 ms** cold and **90 ms** with the prefix
 * cached. Nothing in the log distinguished those two runs.
 *
 * llama.cpp appends a `timings` object (and `usage.prompt_tokens_details.
 * cached_tokens`) to the last chunk of a streamed completion, which is exactly
 * that missing measurement, free of charge. This reads it.
 *
 * Deliberately tolerant of absent or malformed fields: these are diagnostics,
 * and a build that stops sending them must cost a log line, never a turn.
 */
export interface RoundTimings {
  /** Prompt tokens llama-server found already in its cache and did not re-read. */
  cachedTokens: number
  /** Prompt tokens it actually had to read this round. */
  readTokens: number
  /** Milliseconds spent reading them. */
  readMs: number
  /** Tokens generated. */
  predictedTokens: number
  /** Milliseconds spent generating them. */
  predictedMs: number
}

function finiteOrNull(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Read the timings off a stream chunk, or `null` when it is not the one
 * carrying them (every chunk but the last) or the build does not send them.
 */
export function roundTimingsOf(chunk: unknown): RoundTimings | null {
  const source = (chunk as { timings?: unknown } | null)?.timings as
    Record<string, unknown> | undefined
  if (!source || typeof source !== 'object') return null
  const readTokens = finiteOrNull(source.prompt_n)
  const readMs = finiteOrNull(source.prompt_ms)
  // `prompt_n`/`prompt_ms` are the pair that make this worth logging. Without
  // them there is nothing here the usage block does not already say.
  if (readTokens === null || readMs === null) return null
  return {
    cachedTokens: Math.max(0, finiteOrNull(source.cache_n) ?? 0),
    readTokens: Math.max(0, readTokens),
    readMs: Math.max(0, readMs),
    predictedTokens: Math.max(0, finiteOrNull(source.predicted_n) ?? 0),
    predictedMs: Math.max(0, finiteOrNull(source.predicted_ms) ?? 0)
  }
}

/**
 * The timings as a log payload: rates worked out here rather than left for
 * whoever reads the log to divide in their head, and rounded, because a
 * prompt-reading rate is only ever read to the nearest token per second.
 *
 * `cacheHitPercent` is the number this whole module exists for. At 100 the
 * round was free to start; at 0 it paid for every token of the prompt again.
 */
export function describeRoundTimings(timings: RoundTimings): Record<string, number> {
  const promptTokens = timings.cachedTokens + timings.readTokens
  return {
    promptTokens,
    cachedTokens: timings.cachedTokens,
    cacheHitPercent: promptTokens > 0 ? Math.round((timings.cachedTokens / promptTokens) * 100) : 0,
    readTokens: timings.readTokens,
    readMs: Math.round(timings.readMs),
    readTokensPerSecond:
      timings.readMs > 0 ? Math.round((timings.readTokens / timings.readMs) * 1000) : 0,
    predictedTokens: timings.predictedTokens,
    predictedMs: Math.round(timings.predictedMs),
    predictedTokensPerSecond:
      timings.predictedMs > 0
        ? Math.round((timings.predictedTokens / timings.predictedMs) * 1000)
        : 0
  }
}
