/**
 * Crediting Anodex on the commits it writes.
 *
 * Git has one conventional way to say "more than one party made this commit",
 * and GitHub reads it: a `Co-Authored-By: Name <email>` trailer. GitHub
 * matches that address against the verified emails on its accounts — on a
 * match it shows that account's avatar, links its profile, and counts the
 * commit toward the repository's contributor list; with no match it shows the
 * name against a generic identicon and counts nothing.
 *
 * So the avatar is not something Anodex can produce on its own. It needs an
 * account that owns {@link ANODEX_COMMIT_EMAIL} and carries the Anodex mark
 * as its picture. Until that exists the trailer is still correct and still
 * honest about who wrote the commit; it just renders plainly.
 *
 * The human stays the *author* either way. Anodex is a co-author, which is
 * what it is — rewriting `GIT_AUTHOR_NAME` would take credit for work it did
 * on someone's behalf, and would break every "who wrote this line" question
 * anyone later asks of the repository.
 */

/** The name shown in the trailer. */
export const ANODEX_COMMIT_NAME = 'Anodex'

/**
 * The address the trailer carries, and the one a GitHub account has to verify
 * for the icon to appear. On `anodex.dev` rather than a `users.noreply`
 * address because the domain is already the project's, and because a noreply
 * address encodes a specific account id that would have to change if the
 * account ever did.
 */
export const ANODEX_COMMIT_EMAIL = 'anodex@anodex.dev'

/** The exact line appended to a commit message. */
export function commitAttributionLine(email: string = ANODEX_COMMIT_EMAIL): string {
  return `Co-Authored-By: ${ANODEX_COMMIT_NAME} <${email.trim() || ANODEX_COMMIT_EMAIL}>`
}

/**
 * Whether this message already credits Anodex.
 *
 * Matched on the name rather than the address so that changing the configured
 * email does not start adding a second trailer to messages that already have
 * one — and so a message written by hand with the credit in it is left alone.
 */
export function hasCommitAttribution(message: string): boolean {
  return message.split('\n').some((line) => /^\s*co-authored-by:\s*anodex\s*</i.test(line))
}

/**
 * `message` with the trailer appended, or unchanged when it is off or already
 * there.
 *
 * Git's own convention is that trailers sit in the last paragraph, separated
 * from the body by a blank line, so that is where this puts it — including
 * for a one-line message, which is the common case and which must not end up
 * with the trailer glued to the subject where it would become part of it.
 */
export function withCommitAttribution(
  message: string,
  options: { enabled: boolean; email?: string }
): string {
  const trimmed = message.replace(/\s+$/, '')
  if (!options.enabled || !trimmed) return message
  if (hasCommitAttribution(trimmed)) return message

  const line = commitAttributionLine(options.email)
  // A message whose last paragraph is already trailers takes the new one into
  // that paragraph; anything else gets a blank line first.
  const lastParagraph = trimmed.split(/\n\s*\n/).pop() ?? ''
  const allTrailers =
    lastParagraph.length > 0 &&
    lastParagraph.split('\n').every((l) => /^[A-Za-z][A-Za-z-]*:\s/.test(l.trim()))
  const isOnlyParagraph = !trimmed.includes('\n\n')

  return allTrailers && !isOnlyParagraph ? `${trimmed}\n${line}\n` : `${trimmed}\n\n${line}\n`
}
