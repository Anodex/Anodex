import type { CriticalThinkingCoverageAssessment } from '@shared/criticalThinking.types'
import type { SearchResult } from '../tools/search/types'
import { MAX_COMPACT_SOURCES } from './criticalThinkingSources'
import { canonicalResearchUrl } from './criticalThinkingUrl'

export const DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY = {
  maxRoundsPerStep: 3,
  maxQueriesPerRound: 3,
  maxResultsPerQuery: 5,
  maxPagesPerRound: 4,
  searchConcurrency: 3,
  fetchConcurrency: 3,
  maxRoundsPerRun: 18,
  maxSearchesPerRun: 24,
  maxFetchesPerRun: 36,
  maxVerifiedSourcesPerRun: MAX_COMPACT_SOURCES,
  maxRunMs: 60 * 60_000
} as const

export interface ResearchSearchBatch {
  query: string
  results: SearchResult[]
}

/**
 * Hosts that reliably serve an anonymous fetcher a login/consent wall instead
 * of citable content — social and UGC platforms that gate their pages behind
 * sign-in. A research run must never spend a fetch on these or, worse, count
 * their "Log in to continue" stub as verified evidence: observed live, a
 * venom-composition step's only two "sources" were Facebook login walls, which
 * then crowded the real PMC/PubMed sources out of that step's bounded excerpt
 * slots. They're excluded at candidate selection so they never reach the
 * fetcher; the general `fetch_url` chat tool is deliberately unaffected (a user
 * may still fetch one of these directly). Matched on the host suffix so
 * subdomains (m.facebook.com, l.instagram.com) are covered.
 */
const NON_RESEARCH_HOSTS = [
  'facebook.com',
  'fb.com',
  'fb.watch',
  'fb.me',
  'instagram.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'tiktok.com',
  'pinterest.com',
  'threads.net',
  'snapchat.com'
]

function isNonResearchHost(host: string): boolean {
  return NON_RESEARCH_HOSTS.some((deny) => host === deny || host.endsWith(`.${deny}`))
}

export interface ResearchCandidate extends SearchResult {
  query: string
  rank: number
}

/** Select bounded, canonical, domain-diverse URLs from real provider results. */
export function selectResearchCandidates(
  batches: ResearchSearchBatch[],
  fetchedUrls: Set<string>,
  limit: number
): ResearchCandidate[] {
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  if (boundedLimit === 0) return []

  const normalizedFetchedUrls = new Set([...fetchedUrls].map((url) => canonicalResearchUrl(url)))
  const terms = new Set(
    batches.flatMap((batch) => batch.query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).slice(0, 48)
  )
  type ScoredCandidate = ResearchCandidate & { score: number; host: string }
  const candidateByUrl = new Map<string, ScoredCandidate>()

  for (const batch of batches) {
    batch.results.forEach((result, index) => {
      const parsed = safePublicUrl(result.url)
      if (!parsed) return
      // Never spend a fetch on a login-walled social/UGC host (see
      // `NON_RESEARCH_HOSTS`) — its stub would verify as junk evidence.
      if (isNonResearchHost(normalizedHost(parsed.hostname))) return
      parsed.hash = ''
      const canonical = canonicalResearchUrl(parsed.toString())
      if (normalizedFetchedUrls.has(canonical)) return
      const searchable = `${result.title} ${result.snippet} ${parsed.hostname}`.toLowerCase()
      const termHits = [...terms].reduce(
        (total, term) => total + (searchable.includes(term) ? 1 : 0),
        0
      )
      const candidate: ScoredCandidate = {
        ...result,
        url: parsed.toString(),
        query: batch.query,
        rank: index + 1,
        host: normalizedHost(parsed.hostname),
        score: termHits * 10 - index
      }
      const existing = candidateByUrl.get(canonical)
      if (!existing || candidate.score > existing.score) candidateByUrl.set(canonical, candidate)
    })
  }

  const candidates = [...candidateByUrl.values()]
  candidates.sort((left, right) => right.score - left.score || left.rank - right.rank)
  const selected: typeof candidates = []
  const selectedHosts = new Set<string>()
  for (const candidate of candidates) {
    if (selectedHosts.has(candidate.host)) continue
    selected.push(candidate)
    selectedHosts.add(candidate.host)
    if (selected.length >= boundedLimit) break
  }
  for (const candidate of candidates) {
    if (selected.includes(candidate)) continue
    selected.push(candidate)
    if (selected.length >= boundedLimit) break
  }
  return selected.map((candidate) => ({
    title: candidate.title,
    url: candidate.url,
    snippet: candidate.snippet,
    query: candidate.query,
    rank: candidate.rank
  }))
}

/** The model proposes sufficiency; the service verifies a minimum evidence floor. */
export function assessmentIsSufficient(
  assessment: CriticalThinkingCoverageAssessment,
  verifiedUrlCount: number
): boolean {
  if (assessment.verdict !== 'sufficient' || assessment.remainingGaps.length > 0) return false
  if (assessment.evidenceBasis === 'multiple-sources') return verifiedUrlCount >= 2
  return assessment.evidenceBasis === 'authoritative-primary' && verifiedUrlCount >= 1
}

/** Run I/O concurrently while preserving input order and containing individual failures. */
export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R> | undefined>(values.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      if (signal?.aborted) return
      const index = cursor++
      try {
        results[index] = { status: 'fulfilled', value: await operation(values[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  const boundedConcurrency = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1
  const workerCount = Math.min(values.length, boundedConcurrency)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  const abortError = new Error('Research operation was cancelled.')
  abortError.name = 'AbortError'
  return Array.from(
    { length: values.length },
    (_, index): PromiseSettledResult<R> =>
      results[index] ?? { status: 'rejected', reason: abortError }
  )
}

function safePublicUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '')
}
