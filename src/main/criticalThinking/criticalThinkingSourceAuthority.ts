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
  // Download portals and app-listing aggregators republish a vendor's own
  // copy wrapped in advertising. They are never the primary source for what
  // a product does, yet they rank alongside it without this.
  //
  // Observed live: a question about a commercial game cited `softonic.com`
  // for a factual claim while the vendor's own site was also in the results.
  // Both scored 0 — aggregator and primary source were indistinguishable to
  // the ranker, and Wikipedia scored below both.
  if (AGGREGATOR_HOST.test(host)) return 'commercial'
  // The named hosts below are the residue of one past pest-control
  // investigation. Kept because removing them is untested churn, but they
  // are not a general rule — a pattern describing a *kind* of source, like
  // the one above, belongs here instead.
  if (
    /\b(blog|pest control|exterminator|sponsored|advertisement)\b/.test(searchable) ||
    /\b(pest|terminix|ehrlich|beekeeping|bestbees|medicalnewstoday)\b/.test(host)
  ) {
    return 'commercial'
  }
  return 'unclassified'
}

/**
 * Software download portals and app-listing aggregators. They carry no
 * original reporting: the text is the vendor's own description surrounded by
 * download buttons, often years stale.
 */
const AGGREGATOR_HOST =
  /(^|\.)(softonic|filehippo|uptodown|malavida|softpedia|majorgeeks|apkpure|apkmirror|slideshare|scribd)\./

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
