import type { ReactNode } from 'react'
import { Button } from '../../components/ui/Button'
import styles from './EmailView.module.css'

/**
 * The states nobody designs.
 *
 * An empty inbox, a mailbox that was never linked, a disconnected account and
 * a search that found nothing are four different situations, and they used to
 * render as the same centred grey envelope with a sentence under it. Two of
 * them are things the reader wants to feel good about, one is a problem to
 * fix, and one is the very first thing anybody sees on this page — so they get
 * their own words, their own mark, and where there is something to do about
 * it, a way to do it.
 */

export type EmailEmptyKind = 'no-account' | 'disconnected' | 'inbox-zero' | 'no-results'

interface EmailEmptyStateProps {
  kind: EmailEmptyKind
  /** The provider's explanation, for `disconnected`. */
  reason?: string
  /** The query that found nothing, for `no-results`. */
  query?: string
  onOpenSettings: () => void
  onClearSearch: () => void
}

export function EmailEmptyState({
  kind,
  reason,
  query,
  onOpenSettings,
  onClearSearch
}: EmailEmptyStateProps): JSX.Element {
  const content = describe(kind, reason, query)

  return (
    <div className={styles.emptyState}>
      {content.mark}
      <h3 className={styles.emptyTitle}>{content.title}</h3>
      <p className={styles.emptyBody}>{content.body}</p>
      {kind === 'no-account' && (
        <Button variant="primary" size="sm" onClick={onOpenSettings}>
          Link a mailbox
        </Button>
      )}
      {kind === 'disconnected' && (
        <Button variant="secondary" size="sm" onClick={onOpenSettings}>
          Open email settings
        </Button>
      )}
      {kind === 'no-results' && (
        <Button variant="secondary" size="sm" onClick={onClearSearch}>
          Clear search
        </Button>
      )}
    </div>
  )
}

interface EmptyContent {
  mark: ReactNode
  title: string
  body: string
}

function describe(kind: EmailEmptyKind, reason?: string, query?: string): EmptyContent {
  switch (kind) {
    case 'no-account':
      return {
        mark: <UnlinkedMark />,
        title: 'No mailbox yet',
        body: 'Link an account and Anodex can read, summarize, draft and send from right here — with every send still behind an approval.'
      }
    case 'disconnected':
      return {
        mark: <DisconnectedMark />,
        title: 'This mailbox needs reconnecting',
        body: reason ?? 'Its credentials are no longer accepted by the provider.'
      }
    case 'no-results':
      return {
        mark: <NoResultsMark />,
        title: 'Nothing matched that search',
        body: query
          ? `No message in this mailbox mentions “${query}”. Try fewer words, or a sender's name.`
          : 'Try fewer words, or a sender’s name.'
      }
    case 'inbox-zero':
      return {
        mark: <InboxZeroMark />,
        title: 'Nothing left in the inbox',
        body: 'Everything here has been read or archived. Starred and All Mail are a click away.'
      }
  }
}

/**
 * An envelope with the logo's three accent points drifting off it — the one
 * place in this view where the full cyan → blue → violet ramp is earned,
 * because it is the first thing a new reader ever sees on this page.
 */
function UnlinkedMark(): JSX.Element {
  return (
    <svg
      className={styles.emptyMark}
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      aria-hidden="true"
    >
      <rect x="10" y="18" width="44" height="30" rx="4" opacity="0.35" />
      <path d="m10 22 22 15 22-15" opacity="0.35" />
      <circle
        className={styles.emptyDrift1}
        cx="48"
        cy="16"
        r="3"
        fill="currentColor"
        stroke="none"
      />
      <circle
        className={styles.emptyDrift2}
        cx="15"
        cy="46"
        r="2"
        fill="var(--accent-violet)"
        stroke="none"
      />
      <circle cx="32" cy="10" r="1.5" fill="var(--accent-cyan)" stroke="none" opacity="0.7" />
    </svg>
  )
}

function DisconnectedMark(): JSX.Element {
  return (
    <svg
      className={styles.emptyMarkWarn}
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      aria-hidden="true"
    >
      <rect x="10" y="18" width="44" height="30" rx="4" opacity="0.35" />
      <path d="m10 22 22 15 22-15" opacity="0.35" />
      {/* The break in the envelope, which is the whole message. */}
      <path d="M20 52 44 14" strokeWidth={2} />
    </svg>
  )
}

function InboxZeroMark(): JSX.Element {
  return (
    <svg
      className={styles.emptyMarkGood}
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      aria-hidden="true"
    >
      <circle cx="32" cy="32" r="18" opacity="0.3" />
      <path d="m24 32 6 6 12-13" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function NoResultsMark(): JSX.Element {
  return (
    <svg
      className={styles.emptyMark}
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      aria-hidden="true"
    >
      <circle cx="28" cy="28" r="14" opacity="0.35" />
      <path d="m38 38 12 12" opacity="0.35" strokeWidth={2} strokeLinecap="round" />
      <path d="M23 28h10" strokeWidth={2} strokeLinecap="round" />
    </svg>
  )
}
