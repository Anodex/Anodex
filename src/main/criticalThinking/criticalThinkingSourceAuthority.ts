export type CriticalThinkingSourceClass =
  'scholarly' | 'official' | 'general-reference' | 'commercial' | 'unclassified'

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
  const searchable = `${title} ${snippet}`.toLowerCase()
  const sourceClass = criticalThinkingSourceClass(url, title, snippet)
  let score =
    sourceClass === 'scholarly'
      ? 70
      : sourceClass === 'official'
        ? 55
        : sourceClass === 'general-reference'
          ? -30
          : sourceClass === 'commercial'
            ? -60
            : 0

  if (
    /\b(systematic review|meta-analysis|clinical guideline|consensus|study|journal)\b/.test(
      searchable
    )
  ) {
    score += 18
  }
  return score
}

export function criticalThinkingSourceClass(
  value: string | URL,
  title = '',
  snippet = ''
): CriticalThinkingSourceClass {
  const url = asUrl(value)
  if (!url) return 'unclassified'
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const searchable = `${title} ${snippet}`.toLowerCase()

  if (
    host === 'pubmed.ncbi.nlm.nih.gov' ||
    host === 'pmc.ncbi.nlm.nih.gov' ||
    host.startsWith('doi.') ||
    /\b(springer|wiley|sciencedirect|frontiersin|nature\.com|scielo|mdpi|tandfonline|sagepub|oup\.com|cambridge\.org)\b/.test(
      host
    )
  ) {
    return 'scholarly'
  }
  if (host.endsWith('.gov') || host.endsWith('.edu') || host.includes('.ac.')) {
    return 'official'
  }
  if (
    host.endsWith('wikipedia.org') ||
    host.endsWith('britannica.com') ||
    /\bencyclopedia\b/.test(searchable)
  ) {
    return 'general-reference'
  }
  if (
    /\b(blog|pest control|exterminator|sponsored|advertisement)\b/.test(searchable) ||
    /\b(pest|terminix|ehrlich|beekeeping|bestbees|medicalnewstoday)\b/.test(host)
  ) {
    return 'commercial'
  }
  return 'unclassified'
}

export function isPreferredCriticalThinkingSource(
  value: string | URL,
  title = '',
  snippet = ''
): boolean {
  const sourceClass = criticalThinkingSourceClass(value, title, snippet)
  return sourceClass === 'scholarly' || sourceClass === 'official'
}

export function isWeakCriticalThinkingSource(
  value: string | URL,
  title = '',
  snippet = ''
): boolean {
  const sourceClass = criticalThinkingSourceClass(value, title, snippet)
  return sourceClass === 'general-reference' || sourceClass === 'commercial'
}

function asUrl(value: string | URL): URL | null {
  if (value instanceof URL) return value
  try {
    return new URL(value)
  } catch {
    return null
  }
}
