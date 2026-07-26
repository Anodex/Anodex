import { create } from 'zustand'
import type {
  EmailConnectionStatus,
  EmailFlagAction,
  EmailMailbox,
  EmailMessage,
  EmailThreadSummary
} from '@shared/email.types'
import { anodex } from '../lib/anodex'
import { notifyError } from './uiStore'

/** Threads fetched per page, and the increment when asking for more. */
const PAGE_SIZE = 20

interface EmailState {
  status: EmailConnectionStatus | null
  threads: EmailThreadSummary[]
  unreadCount: number
  loaded: boolean
  /** Account whose inbox is shown; null follows the default account. */
  activeAccountId: string | null
  /** Active search query, or '' for the plain inbox listing. */
  query: string
  /** Mailbox being listed; null means the account's inbox. */
  mailbox: string | null
  /** Mailboxes available on the active account, loaded lazily. */
  mailboxes: EmailMailbox[]
  /** How many threads to request. Grows as the user asks for more. */
  limit: number
  /** True when the last listing filled the requested limit, so more may exist. */
  hasMore: boolean
  loadingMore: boolean
  /** Thread open in the reading pane, or null when showing the list. */
  openThreadId: string | null
  openMessages: EmailMessage[]
  openLoading: boolean
  busyThreadId: string | null
  /**
   * One-line digests by thread id, filled in behind the listing. Absent means
   * "not yet" rather than "none" — the row shows its provider snippet until a
   * digest arrives, and the arrival is the only thing that changes.
   */
  digests: Record<string, string>
  /** True while a digest batch is in flight, so the list can say it's working. */
  digesting: boolean
  /**
   * True when a pass ended with threads still undigested — no model loaded to
   * summarize with, or the model gave nothing usable back.
   *
   * Worth a flag rather than silence: digests are the one thing this page does
   * that a webmail tab doesn't, and a reader who never sees one has no way to
   * tell whether the feature is broken, absent, or simply hasn't run.
   */
  digestBlocked: boolean

  load: () => Promise<void>
  /** Refreshes only the unread count, for the sidebar badge. */
  refreshUnreadCount: () => Promise<void>
  selectAccount: (accountId: string | null) => Promise<void>
  selectMailbox: (mailbox: string | null) => Promise<void>
  loadMore: () => Promise<void>
  loadMailboxes: () => Promise<void>
  search: (query: string) => Promise<void>
  openThread: (thread: EmailThreadSummary) => Promise<void>
  closeThread: () => void
  applyFlag: (thread: EmailThreadSummary, action: EmailFlagAction) => Promise<void>
  /** Fetches digests for whichever listed threads still lack one. */
  loadDigests: () => Promise<void>
}

let loadRevision = 0
let openRevision = 0
let digestRevision = 0

/** Shared mailbox state used by the Email view and its navigation counter. */
export const useEmailStore = create<EmailState>((set, get) => ({
  status: null,
  threads: [],
  unreadCount: 0,
  loaded: false,
  activeAccountId: null,
  query: '',
  mailbox: null,
  mailboxes: [],
  limit: PAGE_SIZE,
  hasMore: false,
  loadingMore: false,
  openThreadId: null,
  openMessages: [],
  openLoading: false,
  busyThreadId: null,
  digests: {},
  digesting: false,
  digestBlocked: false,

  load: async () => {
    const revision = ++loadRevision
    try {
      const statusResult = await anodex.email.getStatus()
      if (revision !== loadRevision) return
      if (!statusResult.ok) {
        set({ status: null, threads: [], unreadCount: 0, loaded: true })
        return
      }

      const status = statusResult.value
      // Drop a selection whose account was unlinked, so the view falls back to
      // the default rather than repeatedly querying an id that no longer exists.
      const selected = get().activeAccountId
      const activeAccountId =
        selected && status.accounts.some((account) => account.id === selected) ? selected : null

      if (!status.connected && !activeAccountId) {
        set({ status, threads: [], unreadCount: 0, loaded: true, activeAccountId })
        return
      }

      const accountId = activeAccountId ?? undefined
      const query = get().query.trim()
      const limit = get().limit
      const mailbox = get().mailbox ?? undefined
      const [threadsResult, unreadCountResult] = await Promise.all([
        query
          ? anodex.email.search({ query, limit, accountId })
          : anodex.email.listThreads({ limit, accountId, mailbox }),
        anodex.email.getUnreadThreadCount(accountId)
      ])
      if (revision !== loadRevision) return

      const threads = threadsResult.ok ? threadsResult.value : []
      set({
        status,
        activeAccountId,
        threads,
        // A full page back means there is probably another one; a short page
        // means the mailbox is exhausted.
        hasMore: threads.length >= limit,
        unreadCount: unreadCountResult.ok ? unreadCountResult.value : 0,
        loaded: true,
        loadingMore: false
      })
      if (!threadsResult.ok) {
        notifyError(
          query ? 'Could not search mail' : 'Could not load your inbox',
          threadsResult.error.detail ?? threadsResult.error.message
        )
      }
      // Deliberately not awaited: the list is already on screen and useful,
      // and a digest pass involves a mailbox fetch and a model call per thread.
      void get().loadDigests()
    } catch {
      if (revision === loadRevision) {
        set({ status: null, threads: [], unreadCount: 0, loaded: true })
      }
    }
  },

  /**
   * Keeps the sidebar badge honest without pulling a whole listing. Runs on a
   * timer and at startup, so the count means something before the user has
   * ever opened the Email page.
   */
  refreshUnreadCount: async () => {
    const statusResult = await anodex.email.getStatus()
    if (!statusResult.ok) return
    const status = statusResult.value
    set({ status })
    if (!status.connected && !get().activeAccountId) {
      set({ unreadCount: 0 })
      return
    }

    const result = await anodex.email.getUnreadThreadCount(get().activeAccountId ?? undefined)
    // Silent on failure — this is a background poll, and a transient server
    // hiccup should not raise a toast the user did nothing to provoke.
    if (result.ok) set({ unreadCount: result.value })
  },

  selectAccount: async (accountId) => {
    set({
      activeAccountId: accountId,
      openThreadId: null,
      openMessages: [],
      // Mailboxes belong to an account, so the previous account's list and
      // selection are meaningless here.
      mailbox: null,
      mailboxes: [],
      limit: PAGE_SIZE
    })
    await Promise.all([get().load(), get().loadMailboxes()])
  },

  loadMailboxes: async () => {
    const result = await anodex.email.listMailboxes(get().activeAccountId ?? undefined)
    if (result.ok) set({ mailboxes: result.value })
  },

  selectMailbox: async (mailbox) => {
    set({ mailbox, openThreadId: null, openMessages: [], query: '', limit: PAGE_SIZE })
    await get().load()
  },

  loadMore: async () => {
    if (get().loadingMore || !get().hasMore) return
    set({ loadingMore: true, limit: get().limit + PAGE_SIZE })
    await get().load()
  },

  search: async (query) => {
    set({ query, openThreadId: null, openMessages: [], limit: PAGE_SIZE })
    await get().load()
  },

  openThread: async (thread) => {
    const revision = ++openRevision
    set({ openThreadId: thread.id, openMessages: [], openLoading: true })

    const result = await anodex.email.getThreadMessages(thread.id, thread.accountId)
    if (revision !== openRevision) return

    if (!result.ok) {
      set({ openLoading: false, openThreadId: null })
      notifyError('Could not open that conversation', result.error.detail ?? result.error.message)
      return
    }
    set({ openMessages: result.value, openLoading: false })

    // Opening a conversation is the natural moment to clear its unread state,
    // matching every other mail client. Failure here is deliberately silent —
    // the user asked to read the thread, not to mark it, and they already have
    // what they asked for.
    if (thread.unread) void get().applyFlag(thread, 'mark_read')
  },

  closeThread: () => set({ openThreadId: null, openMessages: [], openLoading: false }),

  applyFlag: async (thread, action) => {
    set({ busyThreadId: thread.id })
    try {
      const result = await anodex.email.applyFlag({
        threadId: thread.id,
        action,
        accountId: thread.accountId
      })
      if (!result.ok) {
        notifyError('Could not update that message', result.error.detail ?? result.error.message)
        return
      }
      // Archiving removes the thread from the inbox, so the list it came from
      // is now stale — reload rather than patching a row that shouldn't exist.
      if (action === 'archive' || action === 'unarchive') {
        if (get().openThreadId === thread.id) get().closeThread()
        await get().load()
        return
      }
      set((state) => ({
        threads: state.threads.map((candidate) =>
          candidate.id === thread.id
            ? {
                ...candidate,
                unread:
                  action === 'mark_unread'
                    ? true
                    : action === 'mark_read'
                      ? false
                      : candidate.unread,
                starred: action === 'star' ? true : action === 'unstar' ? false : candidate.starred
              }
            : candidate
        )
      }))
      const unreadResult = await anodex.email.getUnreadThreadCount(thread.accountId)
      if (unreadResult.ok) set({ unreadCount: unreadResult.value })
    } finally {
      set({ busyThreadId: null })
    }
  },

  /**
   * Fills in the missing digests, a batch at a time.
   *
   * The main process caps how many it will generate per call, so this repeats
   * until the listed threads are covered or a pass returns nothing new. A pass
   * that adds nothing means there is no model loaded to summarize with (or the
   * remaining threads keep failing), and retrying would spin — so it stops and
   * leaves those rows on their snippets until the next listing.
   */
  loadDigests: async () => {
    // Supersede rather than skip: a second listing must be able to take over
    // from a batch still running for the previous one, or the new threads
    // would never get digests at all.
    const revision = ++digestRevision
    set({ digesting: true, digestBlocked: false })
    try {
      for (;;) {
        // Re-read the threads each pass: a refresh may have replaced the list
        // while the previous batch was in flight.
        const state = get()
        if (revision !== digestRevision) return
        const pending = state.threads.filter((thread) => !state.digests[thread.id])
        if (pending.length === 0) return

        const result = await anodex.email.digestThreads(
          pending.map((thread) => ({
            accountId: thread.accountId,
            threadId: thread.id,
            latestMessageId: thread.latestMessageId
          }))
        )
        if (revision !== digestRevision) return
        // A pass that adds nothing means there is no model loaded to summarize
        // with, or the remaining threads keep failing — retrying either would
        // spin. Recorded rather than merely returned: this early exit used to
        // be the whole of the feature's failure handling, and it left the page
        // looking as though digests simply did not exist.
        if (!result.ok || result.value.length === 0) {
          set({ digestBlocked: true })
          return
        }

        set((current) => ({
          digests: {
            ...current.digests,
            ...Object.fromEntries(result.value.map((item) => [item.threadId, item.digest]))
          }
        }))
      }
    } finally {
      // Only the newest pass owns the flag; a superseded one bowing out must
      // not clear the indicator for the pass that replaced it.
      if (revision === digestRevision) set({ digesting: false })
    }
  }
}))
