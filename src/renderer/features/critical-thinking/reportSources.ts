/** A URL as the report and the source list both write it, for matching the two. */
export function sameUrl(value: string): string {
  return value.replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '')
}

/**
 * The number each source carries in the report: `[3](url)` makes that url 3.
 * Read from the report, not the list's order, which is the order pages were
 * fetched and never matched the numbers the text used.
 */
export function citationNumbers(report: string): Map<string, number> {
  const numbers = new Map<string, number>()
  for (const match of report.matchAll(/\[(\d+)\]\((https?:\/\/[^\s)]+)\)/g)) {
    const key = sameUrl(match[2])
    if (!numbers.has(key)) numbers.set(key, Number(match[1]))
  }
  return numbers
}
