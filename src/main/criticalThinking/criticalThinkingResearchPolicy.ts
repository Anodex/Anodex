import type {
  CriticalThinkingCoverageAssessment,
  CriticalThinkingProvider,
  CriticalThinkingResearchPolicy
} from '@shared/criticalThinking.types'
import type { SearchResult } from '../tools/search/types'
import { MAX_COMPACT_SOURCES } from './criticalThinkingSources'
import { criticalThinkingSourceAuthorityScore } from './criticalThinkingSourceAuthority'
import { canonicalResearchUrl } from './criticalThinkingUrl'

export const DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY = {
  maxRoundsPerStep: 3,
  maxQueriesPerRound: 3,
  maxResultsPerQuery: 5,
  maxPagesPerRound: 4,
  searchConcurrency: 3,
  fetchConcurrency: 3,
  // A seven-step plan can now give every step its full three-round allowance.
  // The old 18/24/36 totals made the advertised per-step allowance impossible
  // for broad plans and routinely ended a run during its second breadth-first
  // wave, especially when blocked pages still consumed fetch attempts.
  maxRoundsPerRun: 21,
  maxSearchesPerRun: 63,
  maxFetchesPerRun: 84,
  maxVerifiedSourcesPerRun: MAX_COMPACT_SOURCES,
  maxRunMs: 60 * 60_000
} as const

/**
 * The wall-clock budget a run gets, given what its provider can actually do in
 * an hour.
 *
 * The 60-minute default is calibrated for cloud latency, where a research round
 * is seconds. A local model is roughly an order of magnitude slower per round --
 * measured here, a 27B model on one llama-server slot spends minutes on a single
 * round -- so the same hour buys a fraction of the research.
 *
 * Measured live: a six-step plan on a local model spent 64.9 minutes against
 * the 60-minute cap. It finished its rounds first, so the cap did not truncate
 * that particular run -- but it had no headroom left either, and a run whose
 * steps need their full round allowance would be cut off mid-plan.
 *
 * This is headroom, not a fix for a specific failure: the round, search and
 * fetch budgets still bound the work, a run that finishes early still finishes
 * early, and a user who wants a shorter one can set `maxRunMs` directly.
 */
/**
 * Headroom above what a plan's steps are guaranteed, so "spare capacity" can
 * actually exist.
 *
 * The run budgets are sized to exactly the guaranteed allocation -- 21 rounds
 * is seven steps times three -- which reads as generous and behaves as a
 * straitjacket: a seven-step plan has nothing spare by construction, so a step
 * that needs one more round can never have one no matter how close it is.
 *
 * Measured live: a six-step run left three of its rounds unused while three
 * steps stopped one round short of coverage, their gap counts still falling.
 * A seven-step run then consumed all 21 and limited every step, the last on
 * the search/fetch ceiling rather than rounds.
 *
 * Half a round per step is deliberately modest: enough that a few steps can
 * finish what they started, not enough to change what a run costs.
 */
export interface EffectiveRunBudgets {
  maxRoundsPerRun: number
  maxSearchesPerRun: number
  maxFetchesPerRun: number
}

export function effectiveRunBudgets(
  policy: CriticalThinkingResearchPolicy,
  stepCount: number
): EffectiveRunBudgets {
  const steps = Math.max(1, stepCount)
  const guaranteed = steps * policy.maxRoundsPerStep
  const maxRoundsPerRun = Math.max(policy.maxRoundsPerRun, guaranteed + Math.ceil(steps / 2))
  // Searches and fetches are budgeted per round, so they scale with it or they
  // simply become the next ceiling to hit -- which is what limited the seventh
  // step of that run on `tool-limit` rather than rounds.
  const scale = maxRoundsPerRun / Math.max(1, policy.maxRoundsPerRun)
  return {
    maxRoundsPerRun,
    maxSearchesPerRun: Math.ceil(policy.maxSearchesPerRun * scale),
    maxFetchesPerRun: Math.ceil(policy.maxFetchesPerRun * scale)
  }
}

export function researchRunBudgetMs(provider: CriticalThinkingProvider): number {
  const base = DEFAULT_CRITICAL_THINKING_RESEARCH_POLICY.maxRunMs
  return provider === 'local' ? base * 3 : base
}

export interface ResearchSearchBatch {
  query: string
  results: SearchResult[]
}

/**
 * Hosts that never yield citable text to an anonymous HTML fetch — either a
 * login/consent wall (social/UGC platforms gated behind sign-in) or a
 * media-only page whose actual content is audio/video, so extraction returns
 * navigation/footer chrome instead. A research run must never spend a fetch on
 * these or, worse, count their stub as verified evidence: observed live, a
 * venom-composition step's only "sources" were Facebook login walls, and a
 * later run cited a YouTube page whose extracted "evidence" was
 * "About Press Copyright … © 2026 Google LLC." Either way the junk then crowds
 * real PMC/PubMed sources out of that step's bounded excerpt slots. They're
 * excluded at candidate selection so they never reach the fetcher; the general
 * `fetch_url` chat tool is deliberately unaffected (a user may still fetch one
 * directly). Matched on the host suffix so subdomains (m.facebook.com,
 * l.instagram.com) are covered.
 */
const NON_RESEARCH_HOSTS = [
  // Login/consent-walled social & UGC platforms.
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
  'snapchat.com',
  // Media-only hosts whose content is video/audio, not extractable text.
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'dailymotion.com',
  // Pages that consistently return login walls, discussion answers, or tiny
  // metadata stubs rather than the underlying paper. Prefer the publisher,
  // DOI, PubMed/PMC, university, or government result instead.
  'quora.com',
  'researchgate.net',
  'academia.edu',
  'semanticscholar.org'
]

function isNonResearchHost(host: string): boolean {
  return NON_RESEARCH_HOSTS.some((deny) => host === deny || host.endsWith(`.${deny}`))
}

export interface ResearchCandidate extends SearchResult {
  query: string
  rank: number
}

/**
 * A query term is *distinctive* when few of that query's own results contain
 * it. Those are the terms that locate the question — a place, an
 * organization, a specific mechanism — while a term nearly every result
 * shares carries no ranking information at all. Derived per batch from the
 * results themselves, so it needs no maintained list of which words are
 * generic, in any subject.
 *
 * Counting every term equally is what let a Colorado-scoped step fill up with
 * a Chinese excavator manufacturer, a UAE dealer, and Hitachi Construction
 * Machinery Africa: each matched "construction", "mining", "excavators",
 * "wheel", "loaders" and "projects" — six points — while the one Colorado
 * source matched two terms and lost.
 */
const DISTINCTIVE_TERM_RESULT_FRACTION = 0.4
const DISTINCTIVE_TERM_SCORE = 18
const GENERIC_TERM_SCORE = 4
const MAX_SCORED_GENERIC_TERMS = 5
/**
 * Matching none of the distinctive terms is not merely a low score — it is
 * positive evidence that a result answers some *other* question that happens
 * to share this one's generic vocabulary. Ranking it below an on-scope result
 * takes a penalty, not just fewer points, because generic matches are
 * plentiful and distinctive ones are rare by construction. Applied only when
 * the query has distinctive terms at all; when every result shares every
 * term, nothing here separates them and ordering falls to source authority
 * and provider rank, as before.
 */
const OFF_SCOPE_PENALTY = 25

interface QueryTermWeights {
  distinctive: string[]
  generic: string[]
}

function weighQueryTerms(terms: string[], searchables: string[]): QueryTermWeights {
  if (searchables.length === 0) return { distinctive: [], generic: terms }
  const distinctive: string[] = []
  const generic: string[] = []
  for (const term of terms) {
    const documentFrequency = searchables.reduce(
      (total, text) => total + (text.includes(term) ? 1 : 0),
      0
    )
    const bucket =
      documentFrequency / searchables.length <= DISTINCTIVE_TERM_RESULT_FRACTION
        ? distinctive
        : generic
    bucket.push(term)
  }
  return { distinctive, generic }
}

function relevanceScore(searchable: string, weights: QueryTermWeights): number {
  const distinctiveHits = weights.distinctive.filter((term) => searchable.includes(term)).length
  const genericHits = weights.generic.filter((term) => searchable.includes(term)).length
  const offScope = weights.distinctive.length > 0 && distinctiveHits === 0 ? OFF_SCOPE_PENALTY : 0
  return (
    distinctiveHits * DISTINCTIVE_TERM_SCORE +
    Math.min(genericHits, MAX_SCORED_GENERIC_TERMS) * GENERIC_TERM_SCORE -
    offScope
  )
}

function hostnameOf(value: string): string {
  return safePublicUrl(value)?.hostname ?? ''
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
  type ScoredCandidate = ResearchCandidate & { score: number; host: string }
  const candidateByUrl = new Map<string, ScoredCandidate>()

  for (const batch of batches) {
    const queryTerms = [...new Set(batch.query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])]
    const searchables = batch.results.map((result) =>
      `${result.title} ${result.snippet} ${hostnameOf(result.url)}`.toLowerCase()
    )
    const termWeights = weighQueryTerms(queryTerms, searchables)
    batch.results.forEach((result, index) => {
      const parsed = safePublicUrl(result.url)
      if (!parsed) return
      // Never spend a fetch on a login-walled social/UGC host (see
      // `NON_RESEARCH_HOSTS`) — its stub would verify as junk evidence.
      if (isNonResearchHost(normalizedHost(parsed.hostname))) return
      parsed.hash = ''
      const canonical = canonicalResearchUrl(parsed.toString())
      if (normalizedFetchedUrls.has(canonical)) return
      const candidate: ScoredCandidate = {
        ...result,
        url: parsed.toString(),
        query: batch.query,
        rank: index + 1,
        host: normalizedHost(parsed.hostname),
        score:
          relevanceScore(searchables[index], termWeights) +
          criticalThinkingSourceAuthorityScore(parsed, result.title, result.snippet) -
          index
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
    // The diversity pass may already have filled the requested limit. The old
    // code checked only after pushing here, selecting limit + 1 pages whenever
    // another candidate existed. A live run therefore persisted five URLs in
    // rounds pinned to maxPagesPerRound: 4 and exhausted its fetch budget early.
    if (selected.length >= boundedLimit) break
    if (selected.includes(candidate)) continue
    selected.push(candidate)
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
