import { describe, expect, it } from 'vitest'
import { findTrashMailbox } from '../trashMailbox'
import type { EmailMailbox } from '@shared/email.types'

/**
 * Which mailbox a deleted message goes to.
 *
 * Every provider has one and none of them agree on what it is called, so the
 * name is the only thing worth matching on — and getting it wrong means a delete
 * that moves somebody's mail into a folder that does not exist, or one that
 * silently does nothing. Resolved once here rather than in each client, which is
 * how the desktop and the phone avoid carrying two different lists of spellings.
 */
const box = (name: string, system = true): EmailMailbox => ({ id: name, name, system })

describe('the mailbox a delete moves to', () => {
  it('finds Gmail behind its namespace', () => {
    // `[Gmail]/Trash` is a path, not a name. Matching the whole string finds
    // nothing; matching the leaf finds it.
    expect(findTrashMailbox([box('INBOX'), box('[Gmail]/Trash')])?.name).toBe('[Gmail]/Trash')
  })

  it("finds Microsoft's", () => {
    expect(findTrashMailbox([box('Inbox'), box('Deleted Items')])?.name).toBe('Deleted Items')
  })

  it('finds a plain IMAP folder under INBOX', () => {
    expect(findTrashMailbox([box('INBOX'), box('INBOX.Trash')])?.name).toBe('INBOX.Trash')
  })

  it('prefers Trash over Deleted Items when an account has both', () => {
    // Order matters: some accounts carry both, one of them a leftover from a
    // migration. The standard name is the one other clients empty.
    const found = findTrashMailbox([box('Deleted Items'), box('Trash')])
    expect(found?.name).toBe('Trash')
  })

  it("prefers the server's folder over a personal one of the same name", () => {
    // Somebody with their own folder called Trash should still have mail go to
    // the server's, which is the one their other clients empty.
    const found = findTrashMailbox([box('Trash', false), box('[Gmail]/Trash', true)])
    expect(found?.name).toBe('[Gmail]/Trash')
  })

  it('refuses rather than guessing when there is no trash', () => {
    // The important one. A null here becomes "this account has no trash" in
    // front of the user; a guess becomes mail moved somewhere nobody looks.
    expect(findTrashMailbox([box('INBOX'), box('Sent')])).toBeNull()
    expect(findTrashMailbox([])).toBeNull()
  })

  it('is not fooled by a folder that merely mentions deleting', () => {
    expect(findTrashMailbox([box('Deleted Drafts'), box('Trash Archive 2019')])).toBeNull()
  })
})
