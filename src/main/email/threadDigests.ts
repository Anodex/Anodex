import type { EmailThreadDigest, EmailThreadDigestRequest } from '@shared/email.types'
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
const inFlight = new Map<string, Promise<EmailThreadDigest | null>>()

/**
 * A digest is only valid for the thread as it stood. Keying on the newest
 * message means a reply landing in the thread invalidates it automatically,
 * with no need to notice the change or expire anything on a timer.
 */
function cacheKey(request: EmailThreadDigestRequest): string {
  return [request.accountId, request.threadId, request.latestMessageId].join('\u0000')
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
 * Returns only the threads it has an answer for. A thread that is not in the
 * result is not an error — it may be over this call's budget, already being
 * generated for another caller, or from a mailbox with no model loaded to
 * summarize it. Every one of those cases leaves the row showing its snippet,
 * which is what it showed before digests existed.
 */
export async function digestThreads(
  requests: EmailThreadDigestRequest[]
): Promise<EmailThreadDigest[]> {
  const results: EmailThreadDigest[] = []
  const misses: EmailThreadDigestRequest[] = []
  let generated = 0

  for (const request of requests) {
    const key = cacheKey(request)
    const cached = cache.get(key)
    if (cached !== undefined) {
      remember(key, cached)
      results.push({ threadId: request.threadId, digest: cached })
      continue
    }
    misses.push(request)
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

    const digest = await task
    if (digest) results.push(digest)
  }

  return results
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
): Promise<EmailThreadDigest | null> {
  try {
    const rendered = await renderThreadForDigest(request)
    if (!rendered) return null
    const digest = await llamaService.digestEmailThread(rendered)
    if (!digest) {
      // No model loaded, or the model gave nothing usable. Both mean "no
      // digest for now" rather than "never" — leaving the key uncached lets
      // a later pass try again once a model is ready.
      return null
    }
    remember(key, digest)
    return { threadId: request.threadId, digest }
  } catch (error) {
    log.warn(`Could not digest thread ${request.threadId}:`, error)
    return null
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
