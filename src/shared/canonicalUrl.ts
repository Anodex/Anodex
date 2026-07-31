/**
 * Normalize a URL for identity comparisons without changing path or query-string
 * case. Hosts are case-insensitive; URL paths are not.
 *
 * Shared by Critical Thinking's source merging and chat's per-turn web source
 * registry so "the same page" means the same thing on both surfaces.
 */
export function canonicalUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  } catch {
    return value.replace(/#.*$/, '').replace(/\/$/, '')
  }
}
