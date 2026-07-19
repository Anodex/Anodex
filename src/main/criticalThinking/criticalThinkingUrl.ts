/**
 * Normalize a research URL for identity comparisons without changing path or
 * query-string case. Hosts are case-insensitive; URL paths are not.
 */
export function canonicalResearchUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  } catch {
    return value.replace(/#.*$/, '').replace(/\/$/, '')
  }
}
