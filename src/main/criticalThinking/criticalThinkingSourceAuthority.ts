/**
 * A small, deterministic authority signal used for ordering—not a truth score.
 * It helps primary, official, and scholarly evidence reach a bounded model
 * context before general-reference or commercial pages.
 */
export function criticalThinkingSourceAuthorityScore(
  value: string | URL,
  title = '',
  snippet = ''
): number {
  const url = asUrl(value)
  if (!url) return 0
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const searchable = `${title} ${snippet}`.toLowerCase()
  let score = 0

  if (
    host.endsWith('.gov') ||
    host === 'pubmed.ncbi.nlm.nih.gov' ||
    host === 'pmc.ncbi.nlm.nih.gov'
  ) {
    score += 70
  } else if (host.endsWith('.edu') || host.includes('.ac.')) {
    score += 50
  } else if (
    host.startsWith('doi.') ||
    host.includes('springer') ||
    host.includes('wiley') ||
    host.includes('sciencedirect') ||
    host.includes('frontiersin') ||
    host.includes('nature.com')
  ) {
    score += 35
  }

  if (
    /\b(systematic review|meta-analysis|clinical guideline|consensus|study|journal)\b/.test(
      searchable
    )
  ) {
    score += 18
  }
  if (host.endsWith('wikipedia.org')) score -= 15
  if (
    /\b(blog|pest control|exterminator|sponsored|advertisement)\b/.test(searchable) ||
    /(^|\.)(blog|pestcontrol|exterminator)\./.test(host)
  ) {
    score -= 25
  }
  return score
}

function asUrl(value: string | URL): URL | null {
  if (value instanceof URL) return value
  try {
    return new URL(value)
  } catch {
    return null
  }
}
