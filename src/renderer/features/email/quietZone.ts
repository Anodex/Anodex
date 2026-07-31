/**
 * Folding bulk mail out of the way.
 *
 * 363 unread is not 363 decisions. Most of an inbox that size is machine-sent
 * — newsletters, receipts, release notes — and none of it is addressed to the
 * reader in the sense that matters. Rather than classify (which would mean a
 * model call per thread, for something a reader can tell at a glance), this
 * reads the sender: the local part a rig sends from, or a subdomain a brand
 * only sends from. It is a heuristic and it is allowed to be wrong, because
 * being wrong costs a click on a bar that is right there.
 */

import type { EmailThreadSummary } from '@shared/email.types'
import { hasSendingSubdomain, parseSender } from './threadRow'

/**
 * Mailbox names nobody reads replies to. Anchored at the start and required to
 * end at a separator so `newsletter` and `no-reply+tag` match while `newsroom`
 * and `replybot` — plausibly a person, or at least something that answers —
 * do not.
 */
const BULK_LOCAL_PART =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|bounces?|mailer[-_.]?daemon|mailer|mailing|newsletters?|news|notifications?|notify|updates?|marketing|digests?|alerts?|campaign|postmaster|automated|auto[-_.]?reply)(?:[-+_.]|$)/i

/**
 * How long a run has to be before folding it is worth it. Two rows collapsing
 * into one bar saves a single row and hides two — below this the fold costs
 * the reader more than it gives them.
 */
export const MIN_QUIET_RUN = 3

export type ThreadListItem =
  | { kind: 'thread'; thread: EmailThreadSummary }
  /** A run of consecutive bulk threads, shown as one bar until expanded. */
  | { kind: 'quiet'; id: string; threads: EmailThreadSummary[] }

/** True when this thread's sender is a machine rather than a correspondent. */
export function isBulkThread(thread: EmailThreadSummary): boolean {
  const { address } = parseSender(thread.from)
  const localPart = address.split('@')[0]?.trim() ?? ''
  return BULK_LOCAL_PART.test(localPart) || hasSendingSubdomain(address)
}

/**
 * Folds each run of consecutive bulk threads into one item, leaving everything
 * else exactly where it was.
 *
 * Runs rather than a global filter, deliberately: the list stays in date
 * order, so a newsletter that arrived between two real messages is still
 * between them, and nothing is ever moved to somewhere the reader has to go
 * looking for it.
 */
export function groupQuietRuns(
  threads: EmailThreadSummary[],
  minRun = MIN_QUIET_RUN
): ThreadListItem[] {
  const items: ThreadListItem[] = []
  let run: EmailThreadSummary[] = []

  const flush = (): void => {
    if (run.length === 0) return
    if (run.length >= minRun) {
      // Keyed on the first thread so an expanded run stays expanded across a
      // refresh that did not change it.
      items.push({ kind: 'quiet', id: `quiet:${run[0].id}`, threads: run })
    } else {
      items.push(...run.map((thread) => ({ kind: 'thread' as const, thread })))
    }
    run = []
  }

  for (const thread of threads) {
    if (isBulkThread(thread)) {
      run.push(thread)
      continue
    }
    flush()
    items.push({ kind: 'thread', thread })
  }
  flush()

  return items
}

/** `9 newsletters and notifications · 4 unread` */
export function describeQuietRun(threads: EmailThreadSummary[]): string {
  const unread = threads.filter((thread) => thread.unread).length
  const label = `${threads.length} newsletter${threads.length === 1 ? '' : 's'} and notifications`
  return unread > 0 ? `${label} · ${unread} unread` : label
}
