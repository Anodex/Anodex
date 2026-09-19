/**
 * Keys for triage, which is the part of mail that is all repetition.
 *
 * A mailbox is mostly decided rather than read: archive, archive, star that
 * one, delete, next. On the phone that is a swipe; here it was a trip to the
 * mouse and back for every message, which is why the phone had quietly become
 * the better of the two for getting through an inbox.
 *
 * The letters are Gmail's, and deliberately not chosen fresh. Anyone who
 * already reaches for `e` to archive has been doing it for years in another
 * client, and a set of keys that is nearly-but-not-quite the familiar one is
 * worse than none: it fails in the direction of doing something else.
 *
 * Everything here is a pure function of the event, because the part most likely
 * to be wrong is not which letter does what — it is the guard that decides the
 * keystroke was aimed at the mail in the first place.
 */

export type MailIntent =
  | 'next'
  | 'previous'
  | 'open'
  | 'back'
  | 'archive'
  | 'trash'
  | 'star'
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'compose'
  | 'search'

/** The parts of a `KeyboardEvent` this reads, so a test need not build one. */
export interface KeyPress {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

/** The parts of an element this reads, for the same reason. */
export interface FocusedElement {
  tagName?: string
  isContentEditable?: boolean
}

/**
 * Whether the keystroke belongs to something being typed into.
 *
 * The whole feature turns on this. A single unmodified letter is both "archive
 * this" and the letter `e` in a sentence somebody is writing, and there is
 * nothing about the key itself that tells them apart — only where the focus is.
 * Get it wrong and typing an address into the search box files the message
 * behind it, which is a bug that destroys work while looking like a typo.
 *
 * `isContentEditable` matters as much as the tag: the message composer is a
 * `div`, and a check that only knew about `input` and `textarea` would treat
 * every letter of a reply as a command.
 */
export function isTypingIn(element: FocusedElement | null | undefined): boolean {
  if (!element) return false
  if (element.isContentEditable) return true
  const tag = element.tagName?.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

/**
 * What a keystroke asks the mailbox to do, or null if it asks nothing.
 *
 * A modifier means the keystroke was aimed past this app — `Ctrl+R` reloads,
 * `Cmd+F` opens the browser's find, `Alt+E` opens a menu on Windows — so
 * anything held is a refusal rather than a different shortcut. `Shift` is the
 * exception, because `#` is typed with it and because `Shift+/` is how a `?`
 * arrives on most layouts.
 */
export function mailIntentFor(event: KeyPress): MailIntent | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null

  switch (event.key) {
    case 'j':
    case 'ArrowDown':
      return 'next'
    case 'k':
    case 'ArrowUp':
      return 'previous'
    case 'o':
    case 'Enter':
      return 'open'
    case 'u':
    case 'Escape':
      return 'back'
    case 'e':
      return 'archive'
    // `#` is Gmail's, and `Delete` is what somebody who has never used Gmail
    // will reach for. Both move the message to the account's trash; nothing
    // here expunges anything, which is the only reason a single key is allowed
    // to do it at all.
    case '#':
    case 'Delete':
      return 'trash'
    case 's':
      return 'star'
    case 'r':
      return 'reply'
    case 'a':
      return 'replyAll'
    case 'f':
      return 'forward'
    case 'c':
      return 'compose'
    case '/':
      return 'search'
    default:
      return null
  }
}

/**
 * The thread `j` or `k` lands on.
 *
 * Reading-pane clients move and open in one step, so there is no separate
 * cursor to keep in sync with the list — the open thread *is* the cursor, and
 * a list that has been refiltered or refreshed underneath simply answers from
 * where it is now.
 *
 * Stops at the ends rather than wrapping. Wrapping means holding `j` at the
 * bottom of an inbox silently returns you to the top, and the next `e` archives
 * a message you read this morning.
 */
export function stepThread(
  ids: readonly string[],
  current: string | null,
  delta: 1 | -1
): string | null {
  if (ids.length === 0) return null
  // Nothing open yet: the first key lands on the end it came from, so `j` from
  // a fresh list opens the newest message and `k` opens the oldest.
  if (current === null) return delta === 1 ? ids[0] : ids[ids.length - 1]

  const at = ids.indexOf(current)
  // The open thread is no longer in the list — archived, or filtered out by a
  // search that ran while it was open. Treating that as "start again" is
  // better than doing nothing, which reads as a broken key.
  if (at === -1) return delta === 1 ? ids[0] : ids[ids.length - 1]

  const next = at + delta
  return next >= 0 && next < ids.length ? ids[next] : null
}

/**
 * Everything a key needs to act on, and everything it can do.
 *
 * Gathered into one object so the dispatch below is a function rather than
 * forty lines inside a `useEffect`. That is not tidiness: a keystroke that
 * archives the wrong message, or archives when nothing is open, is not
 * something this codebase can find by clicking -- the desktop cannot be driven
 * from here. A seam is the only way any of it gets exercised.
 */
export interface MailKeyContext<Thread extends { id: string; starred?: boolean }, Message> {
  /** Every row currently listed, in the order they are shown. */
  threads: readonly Thread[]
  /** The thread being read, or null on the list. */
  openThreadId: string | null
  /** The newest message of the open thread — what a reply answers. */
  newest: Message | null
  open: (thread: Thread) => void
  close: () => void
  flag: (thread: Thread, action: 'star' | 'unstar' | 'archive') => void
  trash: (thread: Thread) => void
  reply: (message: Message, all: boolean) => void
  forward: (message: Message) => void
  compose: () => void
  focusSearch: () => void
}

/**
 * Do what the key asked, and say whether anything was done.
 *
 * The return value is what decides `preventDefault`. A key the mailbox
 * declined — `e` with nothing open, `r` on a thread still loading — has to
 * keep travelling, or the shortcut becomes a way of silently swallowing
 * keystrokes that something else wanted.
 */
export function applyMailIntent<Thread extends { id: string; starred?: boolean }, Message>(
  intent: MailIntent,
  context: MailKeyContext<Thread, Message>
): boolean {
  const { threads, openThreadId, newest } = context
  const summary = threads.find((thread) => thread.id === openThreadId) ?? null

  const go = (delta: 1 | -1): boolean => {
    const id = stepThread(
      threads.map((thread) => thread.id),
      openThreadId,
      delta
    )
    const next = id === null ? null : threads.find((thread) => thread.id === id)
    if (!next) return false
    context.open(next)
    return true
  }

  switch (intent) {
    case 'next':
      return go(1)
    case 'previous':
      return go(-1)
    // On the list this is "open the one I am looking at", and the newest is
    // the only one there is to mean. In the reader it is already open.
    case 'open':
      return openThreadId === null ? go(1) : false
    case 'back':
      if (openThreadId === null) return false
      context.close()
      return true
    case 'archive':
      if (!summary) return false
      context.flag(summary, 'archive')
      return true
    case 'trash':
      if (!summary) return false
      context.trash(summary)
      return true
    case 'star':
      if (!summary) return false
      // Read off the row rather than kept anywhere: a toggle that remembers
      // its own state disagrees with the mailbox the moment anything else
      // changes it.
      context.flag(summary, summary.starred === true ? 'unstar' : 'star')
      return true
    case 'reply':
      if (!newest) return false
      context.reply(newest, false)
      return true
    case 'replyAll':
      if (!newest) return false
      context.reply(newest, true)
      return true
    case 'forward':
      if (!newest) return false
      context.forward(newest)
      return true
    case 'compose':
      context.compose()
      return true
    case 'search':
      context.focusSearch()
      return true
  }
}
