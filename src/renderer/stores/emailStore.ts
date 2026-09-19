import { create } from 'zustand'
import type {
  EmailConnectionStatus,
  EmailDigestOutcome,
  EmailFlagAction,
  EmailMailbox,
  EmailMessage,
  EmailThreadSummary
} from '@shared/email.types'
import { anodex } from '../lib/anodex'
import { notifyError } from './uiStore'
import { reasonFor } from '@shared/result'
import {
  addressList,
  attachedBytes,
  canSend,
  draftPrompt,
  type MailDraft
} from '../features/email/composeMail'

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
   * Why the last pass stopped short, or null when it didn't.
   *
   * Worth recording rather than silence: digests are the one thing this page
   * does that a webmail tab doesn't, and a reader who never sees one has no
   * way to tell whether the feature is broken, absent, or simply hasn't run.
   *
   * The distinction between the reasons matters as much as the flag. A model
   * that is still loading resolves itself in seconds and must not be reported
   * as a fault — doing so is what put a permanent "could not create email
   * summaries" banner over an inbox whose summaries were fine.
   */
  digestBlocked: Exclude<EmailDigestOutcome, 'ok'> | null
  /**
   * Threads the main process has given up summarizing, by thread id, holding
   * the newest message it gave up on. Kept so the list stops counting them as
   * pending work — otherwise "Read my mail" stays lit over an inbox where every
   * remaining thread has already been tried and refused.
   *
   * The message id is what keeps that from being permanent: a reply landing in
   * the thread makes it worth another look, exactly as it retires a digest.
   */
  undigestable: Record<string, string>

  /**
   * The message being written, or null when none is.
   *
   * There was no such thing here until now. This app could read mail and ask
   * the model to answer it, and could not send three words without a model
   * writing them — while the phone could. The model is offered inside this
   * window rather than instead of it.
   */
  composing: MailDraft | null
  sending: boolean
  /** True while the model is writing a body somebody asked for. */
  writing: boolean

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
  /** Delete: moves the thread to the account's trash. */
  trashThread: (thread: EmailThreadSummary) => Promise<void>
  /** Fetches digests for whichever listed threads still lack one. */
  loadDigests: () => Promise<void>
  startCompose: (draft: MailDraft) => void
  updateCompose: (draft: MailDraft) => void
  closeCompose: () => void
  /** Sends what is in the window. Resolves true when it went. */
  sendCompose: () => Promise<boolean>
  /** Opens a file dialog and adds what was chosen to the open message. */
  attachFiles: () => Promise<void>
  /** Takes one file back off, by name. */
  removeAttachment: (filename: string) => void
  /** True while the dialog is open, so the paperclip cannot be double-fired. */
  attaching: boolean
  /** Has the model write the body. The window keeps whatever is typed either way. */
  writeBody: (instruction: string) => Promise<void>
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
  digestBlocked: null,
  undigestable: {},
  composing: null,
  attaching: false,
  sending: false,
  writing: false,

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
          ? // The same folder the listing beside it is showing. `mailbox` was
            // computed one line up and then dropped here, so typing a word while
            // looking at Trash returned mail from the whole account under a
            // heading that still said Trash.
            anodex.email.search({ query, limit, accountId, mailbox })
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
        loaded: true
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
    } catch (error) {
      // An IPC-level rejection, which never becomes a handler's own error
      // result. The view renders `status: null` as "no mail connected", so this
      // path makes a transient failure indistinguishable from an empty setup —
      // logged rather than silent so it is at least answerable from
      // diagnostics, since the alternative is a toast for something the user
      // did nothing to provoke.
      console.error('Failed to load mail:', error)
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
    try {
      await get().load()
    } finally {
      // Cleared here rather than inside `load`, which has four exits that never
      // reached the one place it used to be unset: a failed status call, an
      // account with nothing connected, a load superseded by a newer one, and
      // the catch. Any of those left the flag stuck true, and since it is both
      // this function's own guard and the button's `disabled`, "Load more" was
      // dead for the rest of the session reading "Loading…". Whoever sets the
      // flag clears it.
      set({ loadingMore: false })
    }
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

  // Bumping the revision cancels a fetch still in flight for the thread being
  // closed. Without it, the reply landed after the pane had gone and wrote its
  // messages into a store that no longer had a thread open — leaving
  // `openMessages` holding a closed conversation until something else replaced
  // it, and the next open briefly showing the previous thread's mail.
  closeThread: () => {
    openRevision += 1
    set({ openThreadId: null, openMessages: [], openLoading: false })
  },

  trashThread: async (thread) => {
    set({ busyThreadId: thread.id })
    try {
      const result = await anodex.email.trash({
        threadId: thread.id,
        accountId: thread.accountId
      })
      if (!result.ok) {
        notifyError('Could not delete that message', result.error.detail ?? result.error.message)
        return
      }
      // Gone from this mailbox, so the list it came from is stale — reload
      // rather than patching a row that should not exist, the same reasoning
      // archiving already uses below.
      if (get().openThreadId === thread.id) get().closeThread()
      await get().load()
    } finally {
      set({ busyThreadId: null })
    }
  },

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
   * until the listed threads are covered or a pass reports there is no point
   * asking again — no engine yet, or a fault. Each batch also names the threads
   * it has given up on, which are what stopped the old version: they never
   * became digests, so they stayed pending, so every later pass came back empty
   * and the page reported a working feature as broken.
   */
  loadDigests: async () => {
    // Supersede rather than skip: a second listing must be able to take over
    // from a batch still running for the previous one, or the new threads
    // would never get digests at all.
    const revision = ++digestRevision
    set({ digesting: true, digestBlocked: null })
    try {
      for (;;) {
        // Re-read the threads each pass: a refresh may have replaced the list
        // while the previous batch was in flight.
        const state = get()
        if (revision !== digestRevision) return
        const pending = state.threads.filter(
          (thread) =>
            !state.digests[thread.id] && state.undigestable[thread.id] !== thread.latestMessageId
        )
        if (pending.length === 0) return

        const result = await anodex.email.digestThreads(
          pending.map((thread) => ({
            accountId: thread.accountId,
            threadId: thread.id,
            latestMessageId: thread.latestMessageId
          }))
        )
        if (revision !== digestRevision) return
        if (!result.ok) {
          set({ digestBlocked: 'failed' })
          return
        }

        const { digests, outcome, abandonedThreadIds } = result.value
        set((current) => ({
          digests: {
            ...current.digests,
            ...Object.fromEntries(digests.map((item) => [item.threadId, item.digest]))
          },
          undigestable: {
            ...current.undigestable,
            ...Object.fromEntries(
              abandonedThreadIds.flatMap((id) => {
                const thread = pending.find((candidate) => candidate.id === id)
                return thread ? [[id, thread.latestMessageId] as const] : []
              })
            )
          }
        }))

        // Stopping conditions, in the order they matter. A pass that resolved
        // none of what it asked about made no progress, so looping on it would
        // spin — but it is only worth reporting when the pass says something
        // actually went wrong.
        if (outcome !== 'ok') {
          set({ digestBlocked: outcome })
          return
        }
        // Progress is measured against the threads this pass actually asked
        // about, not against the response being non-empty. A reply that named
        // only threads outside the current listing would leave `pending`
        // unchanged and satisfy a bare length check, and the loop would send
        // the identical request forever.
        const resolved = new Set([...digests.map((item) => item.threadId), ...abandonedThreadIds])
        if (!pending.some((thread) => resolved.has(thread.id))) return
      }
    } finally {
      // Only the newest pass owns the flag; a superseded one bowing out must
      // not clear the indicator for the pass that replaced it.
      if (revision === digestRevision) set({ digesting: false })
    }
  },

  startCompose: (draft) => set({ composing: draft }),

  updateCompose: (draft) => set({ composing: draft }),

  closeCompose: () => set({ composing: null, writing: false }),

  /**
   * Send it.
   *
   * The window stays open until the computer says it went. A window that closes
   * on click and fails afterwards loses the message *and* tells somebody it was
   * sent, which is the worst of the three outcomes available here.
   */
  sendCompose: async () => {
    const draft = get().composing
    if (!draft || !canSend(draft) || get().sending) return false

    set({ sending: true })
    try {
      const result = await anodex.email.send({
        to: addressList(draft.to),
        cc: addressList(draft.cc),
        bcc: addressList(draft.bcc),
        subject: draft.subject.trim(),
        body: draft.body,
        accountId: draft.accountId,
        // Only when there are some. An empty array is harmless to every
        // adapter here, but it lands in the wire log of every plain message
        // ever sent, and the field is only interesting when it is used.
        ...(draft.attachments.length > 0 ? { attachments: draft.attachments } : {}),
        // Threading, which is what makes a reply land in the conversation it
        // answers rather than starting a new one beside it.
        ...(draft.inReplyTo?.messageIdHeader ? { inReplyTo: draft.inReplyTo.messageIdHeader } : {}),
        ...(draft.inReplyTo?.references ? { references: draft.inReplyTo.references } : {}),
        ...(draft.inReplyTo?.threadId ? { threadId: draft.inReplyTo.threadId } : {})
      })

      if (!result.ok) {
        notifyError('Could not send that message', result.error.detail ?? result.error.message)
        return false
      }

      set({ composing: null })
      // The sent copy belongs in whatever folder is showing it, and a reply
      // changes the thread it answers. Cheaper to re-read than to guess.
      void get().load()
      return true
    } finally {
      set({ sending: false })
    }
  },

  /**
   * Adds files to the open message.
   *
   * The dialog runs on the computer and hands back the bytes in one call, so
   * there is no path in the renderer and nothing to point at a file nobody
   * chose. The running total goes with the request because the limit is on the
   * message rather than on the click: four files of 6MB are each fine on their
   * own and refused together, and the refusal has to name which one crossed.
   */
  attachFiles: async () => {
    const draft = get().composing
    if (!draft || get().attaching) return

    set({ attaching: true })
    try {
      const result = await anodex.email.pickAttachments(attachedBytes(draft))
      if (!result.ok) {
        notifyError('Could not attach that', reasonFor(result.error))
        return
      }
      if (result.value.length === 0) return

      // Re-read rather than closed over. The dialog is modal to the window but
      // not to this store: a model finishing a draft while the picker was open
      // would otherwise be overwritten by the draft as it was a minute ago.
      const current = get().composing
      if (!current) return

      // By name, because attaching the same file twice is a slip rather than
      // an intention, and two identical rows give no way to tell which is
      // which when removing one.
      const names = new Set(current.attachments.map((one) => one.filename))
      const added = result.value.filter((one) => !names.has(one.filename))
      set({ composing: { ...current, attachments: [...current.attachments, ...added] } })
    } finally {
      set({ attaching: false })
    }
  },

  removeAttachment: (filename) => {
    const draft = get().composing
    if (!draft) return
    set({
      composing: {
        ...draft,
        attachments: draft.attachments.filter((one) => one.filename !== filename)
      }
    })
  },

  /**
   * Have the model write the body.
   *
   * A temporary turn with no history and no project: the mail being answered is
   * in the prompt, and a draft written against whichever project happened to be
   * open would pick up that project's instructions — a reply to a friend in the
   * register of a codebase's contributing guide.
   *
   * Whatever is typed survives a failure. This writes into a window somebody may
   * already have started, and losing their words to a draft that did not arrive
   * would be worse than the draft not arriving.
   */
  writeBody: async (instruction) => {
    const draft = get().composing
    if (!draft || get().writing) return

    set({ writing: true })
    try {
      const id = crypto.randomUUID()
      const result = await anodex.chat.send({
        conversationId: `email-draft-${id}`,
        messageId: id,
        projectId: null,
        history: [],
        prompt: draftPrompt(draft, instruction),
        temporary: true
      })

      if (!result.ok) {
        notifyError('Anodex could not write that', result.error.detail ?? result.error.message)
        return
      }

      const written = result.value.content?.trim()
      if (!written) {
        notifyError('Anodex did not write anything', 'It answered with nothing to put in the body.')
        return
      }

      const current = get().composing
      if (current) set({ composing: { ...current, body: written } })
    } finally {
      set({ writing: false })
    }
  }
}))
