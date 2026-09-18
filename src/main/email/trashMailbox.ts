import type { EmailMailbox } from '@shared/email.types'

/**
 * Which mailbox a deleted message goes to.
 *
 * Every provider has one and none of them agree on what it is called. Gmail
 * exposes `[Gmail]/Trash` or the `TRASH` label, Microsoft says `Deleted Items`,
 * a plain IMAP server says whatever its admin chose — `Trash`, `Deleted`,
 * `Papierkorb`, `Corbeille`. The name is the only thing every adapter reports in
 * common, so the name is what this matches on.
 *
 * Resolved in the main process rather than in each client. The desktop and the
 * phone would otherwise each carry their own list of spellings, and the one that
 * was wrong would fail by moving somebody's mail into a folder that did not
 * exist, or by silently doing nothing.
 */

/**
 * Names that mean "deleted", most standard first.
 *
 * Matched against the *leaf* of the path, so `[Gmail]/Trash` and `INBOX.Trash`
 * both resolve. Lowercased before comparison.
 */
const TRASH_NAMES = ['trash', 'deleted items', 'deleted messages', 'deleted', 'bin', 'recycle bin']

/** `[Gmail]/Trash` -> `trash`, `INBOX.Deleted Items` -> `deleted items`. */
function leaf(name: string): string {
  const withoutNamespace = name.replace(/^\[[^\]]+\][/.]?/, '').trim()
  const last = withoutNamespace.split(/[/.]/).pop()?.trim()
  return (last || name).toLowerCase()
}

/**
 * The account's trash mailbox, or null when it has none.
 *
 * Null rather than a guess. Moving mail into a mailbox that does not exist is
 * how a delete silently loses a message, and a caller that is told "no trash
 * here" can say so instead of reporting a success that did not happen.
 *
 * A system mailbox wins over a user-made one with the same name: somebody with a
 * personal folder called "Trash" alongside the server's should have their mail
 * go to the server's, which is the one their other mail clients empty.
 */
export function findTrashMailbox(mailboxes: EmailMailbox[]): EmailMailbox | null {
  for (const wanted of TRASH_NAMES) {
    const matches = mailboxes.filter((mailbox) => leaf(mailbox.name) === wanted)
    if (matches.length === 0) continue
    return matches.find((mailbox) => mailbox.system) ?? matches[0]
  }
  return null
}
