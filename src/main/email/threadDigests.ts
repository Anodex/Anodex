import type {
  EmailDigestOutcome,
  EmailThreadDigest,
  EmailThreadDigestBatch,
  EmailThreadDigestRequest
} from '@shared/email.types'
import { llamaService } from '../llama/LlamaService'
import { createLogger } from '../utils/logger'
import { emailService } from './EmailService'
import { dedupeParticipants, describeAttachmentsBriefly, threadPreview } from './threadSummary'

const log = createLogger('email:digest')

/**
 * How many digests one request may generate. The inbox list asks for every
 * visible row at once, and each miss costs a mailbox fetch plus a local model
 * call — so a first look at a 50-thread inbox would otherwise mean 50 of each
 * before a single row could render.
 *
 * The renderer asks again after each batch lands, so the list fills in over a
 * few passes instead of stalling on one. Small enough that a user who scrolls
 * straight past a thread never pays for digesting it.
 */
const GENERATE_BUDGET = 5

/**
 * Digests kept in memory, most-recently-used last. Cleared on quit, which is
 * the right lifetime for a derived, regenerable, mailbox-shaped cache — it is
 * not worth a migration or a stale-on-disk failure mode.
 */
const MAX_CACHED = 500

const cache = new Map<string, string>()
/**
 * Work currently being generated, keyed like the cache. An overlapping caller
 * awaits the same promise instead of interpreting "already in progress" as an
 * empty digest batch.
 */
const inFlight = new Map<string, Promise<DigestAttempt>>()
/**
 * Threads there is nothing to summarize for — an empty thread, or one whose
 * messages will not load — keyed like the cache, so a reply landing gives the
 * thread a fresh chance automatically.
 *
 * Remembered rather than simply retried, because a handful of these used to
 * stall the whole feature: they stayed pending forever, refilled the per-call
 * budget ahead of everything else on every pass, and made each pass come back
 * empty, which the list read as "summaries are broken".
 */
const abandoned = new Set<string>()
/** Mailbox loads that threw, by cache key. See `MAX_LOAD_ATTEMPTS`. */
const failures = new Map<string, number>()

/**
 * How many times a thread whose messages will not load is worth retrying
 * before it joins `abandoned`. Two: enough for a timeout on a slow mailbox,
 * few enough that a thread the account can no longer read stops costing a
 * fetch on every pass.
 */
const MAX_LOAD_ATTEMPTS = 2

/**
 * What one generation attempt produced, and — when it produced nothing — why.
 * The reason is the point: the ways to come back empty each want something
 * different from the reader, and only one of them is a fault.
 */
interface DigestAttempt {
  digest: EmailThreadDigest | null
  reason: 'ok' | 'engine-unavailable' | 'nothing-to-read' | 'failed'
}

/**
 * A digest is only valid for the thread as it stood. Keying on the newest
 * message means a reply landing in the thread invalidates it automatically,
 * with no need to notice the change or expire anything on a timer.
 */
function cacheKey(request: EmailThreadDigestRequest): string {
  return [request.accountId, request.threadId, request.latestMessageId].join('\u0000')
}

function abandon(key: string): void {
  abandoned.add(key)
  while (abandoned.size > MAX_CACHED) {
    const oldest = abandoned.values().next()
    if (oldest.done) break
    abandoned.delete(oldest.value)
  }
}

function remember(key: string, digest: string): void {
  // Re-insert so the key counts as most recently used for the eviction below.
  cache.delete(key)
  cache.set(key, digest)
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

/**
 * One-line digests for the inbox list: what each thread actually wants, in
 * place of the provider's raw snippet.
 *
 * Returns the threads it has an answer for, plus why it stopped. A thread that
 * is not in the result is not necessarily an error — it may be over this
 * call's budget, already being generated for another caller, or from a mailbox
 * with no model loaded to summarize it. Every one of those cases leaves the
 * row showing its snippet, which is what it showed before digests existed;
 * `outcome` is what tells the list which of them happened.
 */
export async function digestThreads(
  requests: EmailThreadDigestRequest[]
): Promise<EmailThreadDigestBatch> {
  const digests: EmailThreadDigest[] = []
  const abandonedThreadIds: string[] = []
  const misses: EmailThreadDigestRequest[] = []
  let generated = 0
  let engineUnavailable = false
  let failed = false

  for (const request of requests) {
    const key = cacheKey(request)
    const cached = cache.get(key)
    if (cached !== undefined) {
      remember(key, cached)
      digests.push({ threadId: request.threadId, digest: cached })
      continue
    }
    // Already given up on: skipping it here is what keeps a handful of
    // unreadable threads from consuming the budget on every later pass.
    if (abandoned.has(key)) {
      abandonedThreadIds.push(request.threadId)
      continue
    }
    misses.push(request)
  }

  // Asked once for the whole batch rather than per thread. With no engine
  // there is nothing to attempt, and attempting anyway would spend a mailbox
  // fetch per thread to arrive at the same answer — while looking, from the
  // outside, exactly like a model that failed.
  if (misses.length > 0 && !llamaService.canSummarize()) {
    log.info(`No engine ready to digest ${misses.length} thread(s) yet.`)
    return { digests, outcome: 'engine-unavailable', abandonedThreadIds }
  }

  // Generated one at a time on purpose. The local engine serializes every
  // model call behind a single lock anyway, so firing these concurrently would
  // buy no speed — it would just hold several mailbox fetches open at once and
  // make the whole batch fail together on an abort.
  for (const request of misses) {
    const key = cacheKey(request)
    let task = inFlight.get(key)
    if (!task) {
      if (generated >= GENERATE_BUDGET) continue
      generated += 1
      task = generateDigest(request, key)
      inFlight.set(key, task)
    }

    const attempt = await task
    if (attempt.digest) digests.push(attempt.digest)
    if (attempt.reason === 'engine-unavailable') engineUnavailable = true
    if (attempt.reason === 'failed') failed = true
    if (attempt.reason === 'nothing-to-read') abandonedThreadIds.push(request.threadId)
  }

  return { digests, outcome: outcomeOf({ engineUnavailable, failed }), abandonedThreadIds }
}

/**
 * The pass's own verdict, when its attempts disagreed.
 *
 * An engine that went away mid-pass outranks a failure: it explains any
 * failure alongside it, and unlike a failure it is expected to resolve on its
 * own, so it must not be reported as something the reader has to act on.
 */
function outcomeOf(seen: { engineUnavailable: boolean; failed: boolean }): EmailDigestOutcome {
  if (seen.engineUnavailable) return 'engine-unavailable'
  return seen.failed ? 'failed' : 'ok'
}

/**
 * Generates one cache miss and owns removing its shared promise. The caller
 * awaits these one at a time because the local engine serializes every model
 * call behind one lock anyway; parallel mailbox fetches would add pressure
 * without making the digest pass finish sooner.
 */
async function generateDigest(
  request: EmailThreadDigestRequest,
  key: string
): Promise<DigestAttempt> {
  try {
    const rendered = await renderThreadForDigest(request)
    if (!rendered) {
      // Nothing to summarize, and nothing about this thread will change that
      // until a new message arrives — which is a new cache key. Retrying it
      // every pass would spend the budget on a question already answered.
      log.info(`Nothing to digest in thread ${request.threadId}; not asking again.`)
      abandon(key)
      return { digest: null, reason: 'nothing-to-read' }
    }
    const digest = await llamaService.digestEmailThread(rendered)
    if (!digest) {
      // Leaving the key uncached lets a later pass try again — but which kind
      // of "later" depends on why: an engine that is still loading needs only
      // seconds, whereas a model answering with nothing usable is a fault the
      // reader should hear about.
      const reason = llamaService.canSummarize() ? 'failed' : 'engine-unavailable'
      if (reason === 'failed') {
        log.warn(`The model returned no usable digest for thread ${request.threadId}.`)
      }
      return { digest: null, reason }
    }
    remember(key, digest)
    failures.delete(key)
    return { digest: { threadId: request.threadId, digest }, reason: 'ok' }
  } catch (error) {
    log.warn(`Could not digest thread ${request.threadId}:`, error)
    // A mailbox fetch fails for two very different reasons — a timeout worth
    // retrying, and a thread this account can genuinely no longer read — and
    // nothing in the error reliably tells them apart. So: try again once, then
    // give the budget slot to a thread that can use it.
    const attempts = (failures.get(key) ?? 0) + 1
    failures.set(key, attempts)
    if (attempts < MAX_LOAD_ATTEMPTS) return { digest: null, reason: 'failed' }
    log.info(`Giving up on thread ${request.threadId} after ${attempts} failed loads.`)
    failures.delete(key)
    abandon(key)
    return { digest: null, reason: 'nothing-to-read' }
  } finally {
    inFlight.delete(key)
  }
}

/** The thread as the model should see it: who is talking, and what they said. */
async function renderThreadForDigest(request: EmailThreadDigestRequest): Promise<string | null> {
  const messages = await emailService.getThreadMessages(request.threadId, request.accountId)
  if (messages.length === 0) return null

  const ordered = [...messages].sort((left, right) => left.date - right.date)
  const participants = dedupeParticipants(ordered.map((message) => message.from))
    .slice(0, 6)
    .join('; ')

  return [
    `Subject: ${ordered[0].subject}`,
    participants ? `From: ${participants}` : null,
    '',
    // Newest last, and only the last few — a long thread's early messages are
    // usually settled business, and the row is describing what is outstanding.
    ...ordered.slice(-3).map((message) => {
      // A photo sent with no words has neither body nor snippet, so without
      // the attachment note the digest model would be summarizing an empty
      // string and the row would say less than the snippet it replaced.
      const attached = describeAttachmentsBriefly(message.attachments)
      const said = [threadPreview(message), attached].filter(Boolean).join(' ')
      return `${message.from}: ${said}`
    })
  ]
    .filter(Boolean)
    .join('\n')
}
