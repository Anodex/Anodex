/**
 * Turn a failed search request into something the reader can act on.
 *
 * Every backend used to report `${name} returned HTTP ${status}: ${statusText}`.
 * That is two problems in one line. `statusText` is empty on HTTP/2, which is
 * most live calls, so the message ended on a dangling colon; and the status code
 * alone is the entire diagnosis for the cases that actually happen, none of
 * which the reader can be expected to decode.
 *
 * Measured: a run asked for one search, got `Tavily returned HTTP 432: `,
 * retried it three times and spent all four turns and 10,246 tokens without
 * anything ever saying that the month's search quota was simply used up. The
 * only person who could fix that is the user, and nothing told them.
 *
 * The raw status is always kept — whatever the wording, a bug report needs it.
 */
export function describeSearchHttpError(
  provider: string,
  status: number,
  statusText: string
): string {
  const reason = statusText.trim()
  const detail = reason ? ` (${reason})` : ''
  return `${provider} search failed: ${explain(provider, status)} [HTTP ${status}${detail}]`
}

function explain(provider: string, status: number): string {
  if (status === 401 || status === 403) {
    return `the API key was rejected — check the ${provider} key in Settings → Tools`
  }
  if (status === 429) {
    return 'the request was rate limited; it should work again shortly'
  }
  // 402 is the conventional payment-required code; 432 is Tavily's plan-limit
  // code, which appears in no standard and is easily mistaken for a bug.
  if (status === 402 || status === 432) {
    return `the ${provider} search quota is used up — add credit, or switch search provider in Settings → Tools`
  }
  if (status === 404) {
    return 'the search endpoint was not found — check the configured URL'
  }
  if (status >= 500) {
    return `${provider} is unavailable right now — a server-side error, not a configuration problem`
  }
  return 'the request was rejected'
}
