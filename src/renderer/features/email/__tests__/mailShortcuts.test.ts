import { describe, expect, it } from 'vitest'
import { applyMailIntent, isTypingIn, mailIntentFor, stepThread } from '../mailShortcuts'

/**
 * Single letters that change a mailbox.
 *
 * The risk here is not that `e` fails to archive. It is that `e` archives
 * something while somebody is typing a word, which destroys work and looks
 * like a typo — so most of this file is about the guard rather than the keys.
 */
describe('isTypingIn', () => {
  it('knows the obvious fields', () => {
    for (const tagName of ['input', 'textarea', 'select', 'INPUT', 'TextArea']) {
      expect(isTypingIn({ tagName })).toBe(true)
    }
  })

  it('knows a rich editor is a field too', () => {
    // The composer body is a contenteditable `div`. A guard that only knew
    // about `input` and `textarea` would read every letter of a reply as a
    // command — archiving the message being answered somewhere around the
    // first "e".
    expect(isTypingIn({ tagName: 'div', isContentEditable: true })).toBe(true)
  })

  it('lets an ordinary element through', () => {
    expect(isTypingIn({ tagName: 'div' })).toBe(false)
    expect(isTypingIn({ tagName: 'button' })).toBe(false)
  })

  it('survives having nothing focused', () => {
    // `document.activeElement` is null in a freshly loaded document and after
    // the focused node is removed, which happens every time a thread closes.
    expect(isTypingIn(null)).toBe(false)
    expect(isTypingIn(undefined)).toBe(false)
    expect(isTypingIn({})).toBe(false)
  })
})

describe('mailIntentFor', () => {
  it('maps the keys people already have in their hands', () => {
    const expected: Record<string, string> = {
      j: 'next',
      k: 'previous',
      o: 'open',
      u: 'back',
      e: 'archive',
      '#': 'trash',
      s: 'star',
      r: 'reply',
      a: 'replyAll',
      f: 'forward',
      c: 'compose',
      '/': 'search'
    }
    for (const [key, intent] of Object.entries(expected)) {
      expect(mailIntentFor({ key })).toBe(intent)
    }
  })

  it('accepts the keys somebody who has never used Gmail would try', () => {
    expect(mailIntentFor({ key: 'ArrowDown' })).toBe('next')
    expect(mailIntentFor({ key: 'ArrowUp' })).toBe('previous')
    expect(mailIntentFor({ key: 'Enter' })).toBe('open')
    expect(mailIntentFor({ key: 'Escape' })).toBe('back')
    expect(mailIntentFor({ key: 'Delete' })).toBe('trash')
  })

  it('refuses anything with a modifier held', () => {
    // Not a nicety. `Ctrl+R` reloads, `Cmd+F` is find, `Alt+E` opens a menu on
    // Windows — every one of those is a key this file also claims, and taking
    // them would break the application around the mail.
    for (const held of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      expect(mailIntentFor({ key: 'r', [held]: true })).toBeNull()
      expect(mailIntentFor({ key: 'e', [held]: true })).toBeNull()
      expect(mailIntentFor({ key: 'a', [held]: true })).toBeNull()
    }
  })

  it('allows shift, because some of these need it', () => {
    // `#` and `/` are shifted characters on most layouts, so refusing shift
    // would quietly remove delete and search on exactly the keyboards that
    // need them most.
    expect(mailIntentFor({ key: '#', shiftKey: true })).toBe('trash')
    expect(mailIntentFor({ key: '/', shiftKey: true })).toBe('search')
  })

  it('says nothing about keys it does not claim', () => {
    for (const key of ['q', 'z', '5', 'Tab', 'F5', ' ']) {
      expect(mailIntentFor({ key })).toBeNull()
    }
  })
})

describe('stepThread', () => {
  const ids = ['t1', 't2', 't3']

  it('moves down and up', () => {
    expect(stepThread(ids, 't1', 1)).toBe('t2')
    expect(stepThread(ids, 't2', -1)).toBe('t1')
  })

  it('stops at the ends instead of wrapping', () => {
    // Holding `j` at the bottom of an inbox must not silently return to the
    // top, because the next `e` would then archive something read hours ago.
    expect(stepThread(ids, 't3', 1)).toBeNull()
    expect(stepThread(ids, 't1', -1)).toBeNull()
  })

  it('starts at the end it came from', () => {
    expect(stepThread(ids, null, 1)).toBe('t1')
    expect(stepThread(ids, null, -1)).toBe('t3')
  })

  it('recovers when the open thread has left the list', () => {
    // It was archived, or a search ran while it was open. Doing nothing here
    // reads as a broken key; starting again is at least a movement the user
    // can see and undo.
    expect(stepThread(ids, 'gone', 1)).toBe('t1')
    expect(stepThread(ids, 'gone', -1)).toBe('t3')
  })

  it('has nothing to say about an empty mailbox', () => {
    expect(stepThread([], null, 1)).toBeNull()
    expect(stepThread([], 't1', 1)).toBeNull()
  })
})

/**
 * What a key actually does to the mailbox.
 *
 * Split out of the view so it can be exercised at all: the desktop app cannot
 * be driven from this machine, so a `switch` left inside a `useEffect` would
 * have shipped having never run. Every case here is one a person will hit in
 * the first minute -- pressing `e` on the list, `r` before a thread has
 * loaded, `j` at the bottom.
 */
describe('applyMailIntent', () => {
  type Thread = { id: string; starred?: boolean }
  type Message = { id: string }

  const threads: Thread[] = [{ id: 't1' }, { id: 't2', starred: true }, { id: 't3' }]

  function context(over: Partial<Parameters<typeof applyMailIntent<Thread, Message>>[1]> = {}) {
    const calls: string[] = []
    const base = {
      threads,
      openThreadId: null as string | null,
      newest: null as Message | null,
      open: (thread: Thread) => calls.push(`open ${thread.id}`),
      close: () => calls.push('close'),
      flag: (thread: Thread, action: string) => calls.push(`${action} ${thread.id}`),
      trash: (thread: Thread) => calls.push(`trash ${thread.id}`),
      reply: (message: Message, all: boolean) =>
        calls.push(`${all ? 'replyAll' : 'reply'} ${message.id}`),
      forward: (message: Message) => calls.push(`forward ${message.id}`),
      compose: () => calls.push('compose'),
      focusSearch: () => calls.push('search')
    }
    return { calls, ctx: { ...base, ...over } }
  }

  it('moves through the list and opens as it goes', () => {
    const { calls, ctx } = context({ openThreadId: 't1' })
    expect(applyMailIntent('next', ctx)).toBe(true)
    expect(calls).toEqual(['open t2'])
  })

  it('declines at the end of the list rather than wrapping', () => {
    const { calls, ctx } = context({ openThreadId: 't3' })
    expect(applyMailIntent('next', ctx)).toBe(false)
    expect(calls).toEqual([])
  })

  it('does nothing destructive from the list', () => {
    // The one that would cost something. With no thread open there is no
    // "this message", and a key that guessed would archive whatever happened
    // to be first.
    const { calls, ctx } = context({ openThreadId: null })
    for (const intent of ['archive', 'trash', 'star'] as const) {
      expect(applyMailIntent(intent, ctx)).toBe(false)
    }
    expect(calls).toEqual([])
  })

  it('archives and deletes the thread being read, and nothing else', () => {
    const { calls, ctx } = context({ openThreadId: 't2' })
    applyMailIntent('archive', ctx)
    applyMailIntent('trash', ctx)
    expect(calls).toEqual(['archive t2', 'trash t2'])
  })

  it('reads the star off the row instead of remembering it', () => {
    // A toggle that keeps its own idea of the state disagrees with the
    // mailbox the moment anything else changes it -- the phone, the web
    // client, a rule.
    const starred = context({ openThreadId: 't2' })
    applyMailIntent('star', starred.ctx)
    expect(starred.calls).toEqual(['unstar t2'])

    const plain = context({ openThreadId: 't1' })
    applyMailIntent('star', plain.ctx)
    expect(plain.calls).toEqual(['star t1'])
  })

  it('will not reply to a thread that has not loaded', () => {
    // `r` pressed in the second between opening a thread and its messages
    // arriving. Composing a reply to nothing would open an empty window
    // addressed to no one.
    const { calls, ctx } = context({ openThreadId: 't1', newest: null })
    for (const intent of ['reply', 'replyAll', 'forward'] as const) {
      expect(applyMailIntent(intent, ctx)).toBe(false)
    }
    expect(calls).toEqual([])
  })

  it('answers the newest message of the thread', () => {
    const { calls, ctx } = context({ openThreadId: 't1', newest: { id: 'm9' } })
    applyMailIntent('reply', ctx)
    applyMailIntent('replyAll', ctx)
    applyMailIntent('forward', ctx)
    expect(calls).toEqual(['reply m9', 'replyAll m9', 'forward m9'])
  })

  it('closes the reader, and does nothing from the list', () => {
    // Escape on the list must fall through, or it stops reaching the things
    // outside the mailbox that also want it.
    const reading = context({ openThreadId: 't1' })
    expect(applyMailIntent('back', reading.ctx)).toBe(true)
    expect(reading.calls).toEqual(['close'])

    const listing = context({ openThreadId: null })
    expect(applyMailIntent('back', listing.ctx)).toBe(false)
  })

  it('opens the first thread from the list and does nothing in the reader', () => {
    const listing = context({ openThreadId: null })
    expect(applyMailIntent('open', listing.ctx)).toBe(true)
    expect(listing.calls).toEqual(['open t1'])

    const reading = context({ openThreadId: 't2' })
    expect(applyMailIntent('open', reading.ctx)).toBe(false)
  })

  it('composes and searches from anywhere', () => {
    const { calls, ctx } = context()
    expect(applyMailIntent('compose', ctx)).toBe(true)
    expect(applyMailIntent('search', ctx)).toBe(true)
    expect(calls).toEqual(['compose', 'search'])
  })

  it('does nothing at all in an empty mailbox', () => {
    const { calls, ctx } = context({ threads: [], openThreadId: null })
    for (const intent of ['next', 'previous', 'open', 'archive', 'trash'] as const) {
      expect(applyMailIntent(intent, ctx)).toBe(false)
    }
    expect(calls).toEqual([])
  })
})
