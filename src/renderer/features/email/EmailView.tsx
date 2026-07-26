import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  EmailAccountStatus,
  EmailAttachmentSummary,
  EmailMailbox,
  EmailMessage,
  EmailThreadSummary
} from '@shared/email.types'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/ui/Button'
import { useEmailStore } from '../../stores/emailStore'
import { useModelStore } from '../../stores/modelStore'
import { useChatStore } from '../../stores/chatStore'
import { notifyError, useUiStore } from '../../stores/uiStore'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { anodex } from '../../lib/anodex'
import { HtmlMessageBody } from './HtmlMessageBody'
import { EmailEmptyState } from './EmailEmptyState'
import { EmailThreadRail } from './EmailThreadRail'
import { DEFAULT_RAIL_WIDTH, clampRailWidth, loadRailWidth, saveRailWidth } from './railWidth'
import {
  cleanSnippet,
  formatThreadDate,
  identityKey,
  parseSender,
  senderInitial
} from './threadRow'
import { TONE_CLASS, toneFor, useSenderTone, useSenderToneStore } from './senderTones'
import { SenderToneMenu, type SenderToneTarget } from './SenderToneMenu'
import { describeQuietRun, groupQuietRuns } from './quietZone'
import styles from './EmailView.module.css'

/** How far one arrow-key press nudges the rail's edge. */
const RAIL_KEYBOARD_STEP = 24

const PROVIDER_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  microsoft: 'Outlook',
  imap: 'IMAP',
  none: 'No account'
}

/** Providers with a web interface the "Open webmail" button can reach. */
const WEBMAIL_PROVIDERS = new Set(['gmail', 'microsoft'])

export function EmailView(): JSX.Element {
  const status = useEmailStore((s) => s.status)
  const threads = useEmailStore((s) => s.threads)
  const unreadCount = useEmailStore((s) => s.unreadCount)
  const activeAccountId = useEmailStore((s) => s.activeAccountId)
  const openThreadId = useEmailStore((s) => s.openThreadId)
  const openMessages = useEmailStore((s) => s.openMessages)
  const openLoading = useEmailStore((s) => s.openLoading)
  const busyThreadId = useEmailStore((s) => s.busyThreadId)
  const digests = useEmailStore((s) => s.digests)
  const digesting = useEmailStore((s) => s.digesting)
  const digestBlocked = useEmailStore((s) => s.digestBlocked)
  const loadDigests = useEmailStore((s) => s.loadDigests)
  const storedQuery = useEmailStore((s) => s.query)
  const mailbox = useEmailStore((s) => s.mailbox)
  const mailboxes = useEmailStore((s) => s.mailboxes)
  const hasMore = useEmailStore((s) => s.hasMore)
  const loadingMore = useEmailStore((s) => s.loadingMore)
  const selectMailbox = useEmailStore((s) => s.selectMailbox)
  const loadMore = useEmailStore((s) => s.loadMore)
  const loadMailboxes = useEmailStore((s) => s.loadMailboxes)
  const selectAccount = useEmailStore((s) => s.selectAccount)
  const openThread = useEmailStore((s) => s.openThread)
  const closeThread = useEmailStore((s) => s.closeThread)
  const applyFlag = useEmailStore((s) => s.applyFlag)
  const runSearch = useEmailStore((s) => s.search)
  const loadEmail = useEmailStore((s) => s.load)
  const openSettings = useUiStore((s) => s.openSettings)
  const engineStatus = useModelStore((s) => s.engine.status)

  const [queryInput, setQueryInput] = useState(storedQuery)
  /** Folded runs of bulk mail the reader has opened, by run id. */
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<string>>(() => new Set())
  /** The sender whose colour is being picked, and where the menu opens. */
  const [toneTarget, setToneTarget] = useState<SenderToneTarget | null>(null)
  const [railHidden, setRailHidden] = useState(false)
  const [railWidth, setRailWidth] = useState(loadRailWidth)
  const panelRef = useRef<HTMLElement>(null)

  // The rail carries the tool-approval card, so it is genuinely unmounted on a
  // narrow window rather than hidden — an approval prompt the user cannot see
  // would silently stall the model's turn.
  const railFits = useMediaQuery('(min-width: 940px)')

  useEffect(() => {
    void loadEmail()
    void loadMailboxes()
  }, [loadEmail, loadMailboxes])

  const accounts = status?.accounts ?? []
  const active =
    accounts.find((account) => account.id === activeAccountId) ??
    accounts.find((account) => account.isPrimary) ??
    accounts[0]
  const openThreadSummary = threads.find((thread) => thread.id === openThreadId) ?? null

  // Where the digest pass has got to: the first thread that still has no
  // digest. Null once they all do, which is when `digesting` goes false too.
  const sweepThreadId = digesting
    ? (threads.find((thread) => !digests[thread.id])?.id ?? null)
    : null
  const undigested = threads.filter((thread) => !digests[thread.id]).length

  // The two ways a pass comes back empty are worth telling apart: one is
  // something the reader can fix in a click, the other is a fault they should
  // know about rather than read as "this feature does nothing".
  const blockedReason =
    engineStatus === 'ready'
      ? 'Could not read your mail — see the log'
      : 'Load a model to have Anodex read your mail'

  // The Sweep: a band of light resting on the boundary between the threads the
  // model has read and the ones it has not. Its position is the progress —
  // rows above it carry digests, rows below still carry snippets — so the pass
  // needs no spinner and no percentage.
  const sweepBeam = <span className={styles.sweepBeam} aria-hidden="true" />

  // Bulk mail is only folded away in the plain inbox listing. A search is a
  // question the reader asked, and hiding part of its answer behind a bar
  // would make the result quietly wrong.
  const foldsBulk = !storedQuery && mailbox === null
  const listItems = foldsBulk
    ? groupQuietRuns(threads)
    : threads.map((thread) => ({ kind: 'thread' as const, thread }))

  const toggleRun = (id: string): void => {
    setExpandedRuns((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  const renderThread = (thread: EmailThreadSummary): JSX.Element => (
    <Fragment key={thread.id}>
      {thread.id === sweepThreadId && sweepBeam}
      <ThreadRow
        thread={thread}
        digest={digests[thread.id]}
        busy={busyThreadId === thread.id}
        onOpen={() => void openThread(thread)}
        onFlag={(action) => void applyFlag(thread, action)}
        onPickTone={setToneTarget}
      />
    </Fragment>
  )

  const showRail = Boolean(openThreadId) && railFits && !railHidden
  // Opening a thread hands the whole pane to it: the mail and the conversation
  // about it, and nothing else. The list is a place you were, not something to
  // keep half-watching while reading — Back at the top of the reader is how
  // you return to it.
  const layoutClass = !openThreadId ? 'layoutList' : showRail ? 'layoutReaderRail' : 'layoutReader'

  /**
   * Applies a dragged or nudged width, keeping it inside what the panel
   * allows, and reports back what was actually applied — so a caller that
   * wants to remember the width stores the clamped one rather than the
   * request that overshot it.
   */
  const resizeRail = useCallback((width: number): number => {
    const panelWidth = panelRef.current?.getBoundingClientRect().width ?? 0
    const applied = clampRailWidth(width, panelWidth)
    setRailWidth(applied)
    return applied
  }, [])

  // Re-clamps when the window shrinks. Without this a rail dragged wide on a
  // maximized window would still be that wide after a restore, leaving the
  // mail a sliver — the bounds have to be re-applied, not just enforced at
  // the moment of dragging.
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel || !showRail) return
    const observer = new ResizeObserver(([entry]) => {
      setRailWidth((current) => clampRailWidth(current, entry.contentRect.width))
    })
    observer.observe(panel)
    return () => observer.disconnect()
  }, [showRail])

  const handleOpenWebmail = async (): Promise<void> => {
    const result = await anodex.email.openWebmail()
    if (!result.ok) {
      notifyError('Could not open webmail', result.error.detail ?? result.error.message)
    }
  }

  const submitSearch = (event: React.FormEvent): void => {
    event.preventDefault()
    void runSearch(queryInput)
  }

  const clearSearch = (): void => {
    setQueryInput('')
    void runSearch('')
  }

  return (
    <div className={styles.view}>
      {toneTarget && <SenderToneMenu target={toneTarget} onClose={() => setToneTarget(null)} />}
      {/* One bar for the whole of the page's chrome. The title, which mailbox
          you are in, and the search that filters it are one thought, and they
          used to cost four stacked bands to say. */}
      <div className={styles.cmdBar}>
        <div className={styles.cmdTitle}>
          <h1 className={styles.title}>Email</h1>
          {unreadCount > 0 && (
            <span className={styles.unreadPill} title={`${unreadCount} unread`}>
              {unreadCount}
            </span>
          )}
        </div>

        {active && (
          <AccountSwitcher
            accounts={accounts}
            active={active}
            onSelect={(accountId) => void selectAccount(accountId)}
          />
        )}

        {/* Says what the Sweep is doing — and, when it cannot, why. A beam of
            light is nothing to a screen reader, and a pass that quietly
            produced no digests is nothing to anybody. */}
        <span
          className={`${styles.digestStatus} ${digestBlocked ? styles.digestStatusBlocked : ''}`}
          aria-live="polite"
        >
          {digesting ? 'Reading your mail…' : digestBlocked ? blockedReason : ''}
        </span>

        <div className={styles.grow} />

        {active?.connected && (
          <form className={styles.searchInline} onSubmit={submitSearch}>
            <Icon name="search" size={14} />
            <input
              className={styles.searchInput}
              value={queryInput}
              placeholder="Search mail"
              aria-label="Search mail — sender, subject, or keywords"
              onChange={(event) => setQueryInput(event.target.value)}
            />
            {storedQuery && (
              <button
                type="button"
                className={styles.searchClear}
                title="Clear search"
                aria-label="Clear search"
                onClick={clearSearch}
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </form>
        )}

        {active?.connected && (
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Icon name="sparkle" size={15} />}
            disabled={digesting || undigested === 0}
            title={
              undigested === 0
                ? 'Every thread here has already been read'
                : `Summarize ${undigested} thread${undigested === 1 ? '' : 's'} in this list`
            }
            onClick={() => void loadDigests()}
          >
            Read my mail
          </Button>
        )}

        {status && WEBMAIL_PROVIDERS.has(status.provider) && (
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Icon name="web" size={15} />}
            onClick={() => void handleOpenWebmail()}
          >
            Open webmail
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          iconLeft={<Icon name="refresh" size={15} />}
          onClick={() => void loadEmail()}
        >
          Refresh
        </Button>
      </div>

      {/* Scrolls rather than wraps: `orderMailboxes` caps the list at eight,
          but eight long IMAP folder names still became two rows on a narrow
          pane, which moved the mail down every time the window changed. */}
      {active?.connected && mailboxes.length > 0 && (
        <div className={styles.mailboxBar}>
          {storedQuery && (
            <button type="button" className={styles.mbox} aria-pressed={true} onClick={clearSearch}>
              Results
              <Icon name="close" size={11} className={styles.mboxClose} />
            </button>
          )}
          {orderMailboxes(mailboxes).map((candidate) => {
            const isInbox = candidate.name.toUpperCase() === 'INBOX'
            const selected =
              !storedQuery && (isInbox ? mailbox === null : mailbox === candidate.name)
            return (
              <button
                key={candidate.id}
                type="button"
                className={styles.mbox}
                aria-pressed={selected}
                onClick={() => void selectMailbox(isInbox ? null : candidate.name)}
              >
                {friendlyMailboxName(candidate.name)}
                {isInbox && unreadCount > 0 && (
                  <span className={styles.mboxCount}>{unreadCount}</span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {!active?.connected ? (
        <section className={styles.mailboxPanel}>
          <EmailEmptyState
            kind={active ? 'disconnected' : 'no-account'}
            reason={active?.reason}
            onOpenSettings={() => openSettings('email')}
            onClearSearch={clearSearch}
          />
        </section>
      ) : (
        <section
          ref={panelRef}
          className={`${styles.mailboxPanel} ${styles[layoutClass]}`}
          // The rail's track is a dragged value, so it lives here rather than
          // in a stylesheet that can only describe fixed states.
          style={showRail ? { gridTemplateColumns: `minmax(0, 1fr) ${railWidth}px` } : undefined}
        >
          {!openThreadId && (
            <div className={styles.listColumn}>
              {threads.length === 0 ? (
                <EmailEmptyState
                  kind={storedQuery ? 'no-results' : 'inbox-zero'}
                  query={storedQuery}
                  onOpenSettings={() => openSettings('email')}
                  onClearSearch={clearSearch}
                />
              ) : (
                <div className={styles.threadList}>
                  {listItems.map((item) => {
                    if (item.kind === 'thread') return renderThread(item.thread)

                    const expanded = expandedRuns.has(item.id)
                    return (
                      <Fragment key={item.id}>
                        {/* A collapsed run still shows where the pass is, or
                            the beam would vanish for as long as the model
                            spent inside it. */}
                        {!expanded &&
                          item.threads.some((each) => each.id === sweepThreadId) &&
                          sweepBeam}
                        <QuietRun
                          threads={item.threads}
                          expanded={expanded}
                          onToggle={() => toggleRun(item.id)}
                        />
                        {expanded && item.threads.map(renderThread)}
                      </Fragment>
                    )
                  })}
                  {hasMore && (
                    <div className={styles.loadMoreRow}>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={loadingMore}
                        onClick={() => void loadMore()}
                      >
                        {loadingMore ? 'Loading…' : 'Load more'}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {openThreadId && (
            <div className={styles.readerColumn}>
              <ThreadReader
                summary={openThreadSummary}
                messages={openMessages}
                loading={openLoading}
                onClose={closeThread}
                // With the rail on screen the assistant is already here, so
                // Summarize and Reply write into it. Without it — a narrow
                // window — they still hand off to the Chat page, which is
                // where the conversation would otherwise have nowhere to go.
                assistInRail={showRail}
                railHidden={railFits && !showRail}
                onShowRail={() => setRailHidden(false)}
              />
            </div>
          )}

          {showRail && openThreadSummary && (
            <>
              <RailResizer panelRef={panelRef} width={railWidth} onResize={resizeRail} />
              <EmailThreadRail
                thread={openThreadSummary}
                messages={openMessages}
                onCollapse={() => setRailHidden(true)}
              />
            </>
          )}
        </section>
      )}
    </div>
  )
}

interface AccountSwitcherProps {
  accounts: EmailAccountStatus[]
  active: EmailAccountStatus
  onSelect: (accountId: string) => void
}

/**
 * Which mailbox you are reading, and the way to change it.
 *
 * A menu rather than the tab strip this replaces, because the strip's height
 * grew with the number of linked accounts while the information it carried
 * stayed the same: one address is current, the rest are somewhere else. With a
 * single account there is nothing to choose, so it renders as a plain label.
 */
function AccountSwitcher({ accounts, active, onSelect }: AccountSwitcherProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  if (accounts.length < 2) {
    return (
      <span className={styles.accountChip} title={active.address}>
        {localPart(active.address)}
      </span>
    )
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.accountChip} ${styles.accountChipButton}`}
        title={active.address}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setRect(triggerRef.current?.getBoundingClientRect() ?? null)
          setOpen((value) => !value)
        }}
      >
        {localPart(active.address)}
        <Icon name="chevron-down" size={12} className={styles.accountChevron} />
      </button>

      {/* Portalled because the view clips its overflow — a menu rendered in
          flow would be cut off by the pane it drops out of. */}
      {open &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className={styles.accountMenu}
            style={{ top: rect.bottom + 6, left: Math.max(8, rect.left) }}
          >
            {accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                role="menuitemradio"
                aria-checked={account.id === active.id}
                className={styles.accountMenuItem}
                onClick={() => {
                  setOpen(false)
                  if (account.id !== active.id) onSelect(account.id)
                }}
              >
                <Icon
                  name={account.id === active.id ? 'check' : 'mail'}
                  size={14}
                  className={account.id === active.id ? styles.accountMenuCheck : undefined}
                />
                <span className={styles.accountMenuText}>
                  <strong>{account.address}</strong>
                  <small>
                    {PROVIDER_LABELS[account.provider] ?? account.provider}
                    {account.connected ? '' : ' · disconnected'}
                  </small>
                </span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}

/** `sinistercraftnetwork@gmail.com` -> `sinistercraftnetwork`. */
function localPart(address: string): string {
  return address.split('@')[0] || address
}

interface RailResizerProps {
  panelRef: React.RefObject<HTMLElement>
  width: number
  /** Applies a width and returns the one that survived clamping. */
  onResize: (width: number) => number
}

/**
 * The grab bar on the rail's inner edge.
 *
 * Sits outside the grid flow (absolutely positioned) rather than taking a
 * track of its own, so dragging changes exactly one number — the rail's width
 * — instead of shifting a third column around between the two panes.
 *
 * The width is derived from the pointer's distance to the panel's right edge
 * rather than accumulated from deltas: a drag that runs past the clamp and
 * comes back lands where the pointer actually is, instead of the bar drifting
 * away from the cursor by however much travel was thrown away at the limit.
 */
function RailResizer({ panelRef, width, onResize }: RailResizerProps): JSX.Element {
  const [dragging, setDragging] = useState(false)

  const widthAt = (clientX: number): number => {
    const panel = panelRef.current?.getBoundingClientRect()
    return panel ? panel.right - clientX : width
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    // Pointer capture is what lets the drag keep working over the message
    // bodies and the rail's own transcript, which would otherwise swallow the
    // move events the moment the cursor left this 7px strip.
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    setDragging(true)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    onResize(widthAt(event.clientX))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    setDragging(false)
    event.currentTarget.releasePointerCapture(event.pointerId)
    // Persisted once the drag settles, not on every move — the stored value is
    // where the user let go, and writing it 60 times a second to say so would
    // be waste.
    saveRailWidth(width)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Left widens the rail because the edge is what moves, matching the drag.
    const step =
      event.key === 'ArrowLeft'
        ? RAIL_KEYBOARD_STEP
        : event.key === 'ArrowRight'
          ? -RAIL_KEYBOARD_STEP
          : 0
    if (step === 0) return
    event.preventDefault()
    saveRailWidth(onResize(width + step))
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the assistant"
      tabIndex={0}
      className={`${styles.railResizer} ${dragging ? styles.railResizerActive : ''}`}
      style={{ right: width }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      // Back to the default width, the usual escape hatch from a layout the
      // user has dragged somewhere they no longer want.
      onDoubleClick={() => saveRailWidth(onResize(DEFAULT_RAIL_WIDTH))}
    />
  )
}

interface ThreadRowProps {
  thread: EmailThreadSummary
  /** One-line digest of what the thread wants, once one has been generated. */
  digest: string | undefined
  busy: boolean
  onOpen: () => void
  onFlag: (action: 'mark_read' | 'mark_unread' | 'star' | 'archive') => void
  /** Opens the sender-colour menu at the pointer. */
  onPickTone: (target: SenderToneTarget) => void
}

/**
 * One inbox row, ordered the way it is actually triaged: who it is from, then
 * what it is about, then a line of what it says.
 *
 * The subject used to lead and the sender used to sit under it in the muted
 * grey reserved for detail, which is backwards — almost nobody decides what to
 * do with a message before knowing who sent it.
 */
function ThreadRow({
  thread,
  digest,
  busy,
  onOpen,
  onFlag,
  onPickTone
}: ThreadRowProps): JSX.Element {
  const sender = parseSender(thread.from)
  const tone = useSenderTone(sender.address)

  // Only a digest that lands while this row is on screen gets written in.
  // Returning from an opened thread remounts the whole list, and without this
  // every row that already had one would replay the reveal at once — which is
  // the difference between a moment that means something and mere decoration.
  const hadDigestOnMount = useRef(digest !== undefined)
  const revealing = digest !== undefined && !hadDigestOnMount.current

  return (
    <div
      className={`${styles.threadItem} ${thread.unread ? styles.threadUnread : ''}`}
      // Deferred to when nothing is selected. Electron raises its own
      // context-menu event regardless of what the DOM does with this one, and
      // with a selection live that menu carries Copy — which the reader wants
      // far more than a colour picker at that moment.
      onContextMenu={(event) => {
        if (window.getSelection()?.toString()) return
        event.preventDefault()
        onPickTone({ sender, x: event.clientX, y: event.clientY })
      }}
    >
      <button
        type="button"
        className={styles.threadOpen}
        onClick={onOpen}
        // Carries the sender's full address and, once a digest has covered it
        // over, the thread's own words — so the model's reading stays
        // checkable against the source it was made from.
        title={[
          sender.name === sender.address ? sender.address : `${sender.name} <${sender.address}>`,
          thread.subject,
          digest ? cleanSnippet(thread.snippet) : ''
        ]
          .filter(Boolean)
          .join('\n')}
      >
        {/* Decorative: the sender's name is right beside it in text. */}
        <span className={`${styles.avatar} ${TONE_CLASS[tone]}`} aria-hidden="true">
          {senderInitial(sender)}
        </span>

        <span className={styles.threadBody}>
          <span className={styles.threadTitleRow}>
            <span className={styles.sender}>{sender.name}</span>
            {thread.messageCount > 1 && (
              <span className={styles.threadMarks} title={`${thread.messageCount} messages`}>
                <Icon name="chat" size={11} />
                {thread.messageCount}
              </span>
            )}
            {thread.attachmentCount > 0 && (
              <span
                className={styles.threadMarks}
                title={`${thread.attachmentCount} attachment${thread.attachmentCount === 1 ? '' : 's'}`}
              >
                <Icon name="paperclip" size={11} />
              </span>
            )}
          </span>
          <span className={styles.subject}>{thread.subject || '(no subject)'}</span>

          {/* The digest sits over the snippet rather than under it, so the row
              keeps its height while it changes what it says — twenty rows all
              growing a line mid-pass would shove the list around under whoever
              was reading it. A digest is the model's reading of the thread and
              not the thread's own words, which is what the accent edge marks. */}
          <span className={`${styles.previewSlot} ${digest ? styles.hasDigest : ''}`}>
            <small className={styles.snippet}>{cleanSnippet(thread.snippet)}</small>
            {digest !== undefined && (
              <small className={`${styles.threadDigest} ${revealing ? styles.revealing : ''}`}>
                {digest}
              </small>
            )}
          </span>
        </span>
      </button>

      {/* The date and the actions share one cell: the actions arrive exactly
          where the date was, so hovering a row never reflows it. */}
      <div className={styles.threadRight}>
        <span className={styles.when}>{formatThreadDate(thread.updatedAt)}</span>
        <div className={styles.threadActions}>
          <IconAction
            label={thread.unread ? 'Mark as read' : 'Mark as unread'}
            icon={thread.unread ? 'check' : 'mail'}
            disabled={busy}
            onClick={() => onFlag(thread.unread ? 'mark_read' : 'mark_unread')}
          />
          <IconAction label="Star" icon="star" disabled={busy} onClick={() => onFlag('star')} />
          <IconAction
            label="Archive"
            icon="archive"
            disabled={busy}
            onClick={() => onFlag('archive')}
          />
        </div>
      </div>
    </div>
  )
}

interface QuietRunProps {
  threads: EmailThreadSummary[]
  expanded: boolean
  onToggle: () => void
}

/**
 * A run of consecutive machine-sent threads, collapsed to one line.
 *
 * 363 unread is not 363 decisions, and an inbox that presents it as though it
 * were is an inbox nobody finishes. The senders are still shown — as the
 * monograms that identify them everywhere else — so the fold is a summary of
 * what is under it rather than a lid over an unknown.
 */
function QuietRun({ threads, expanded, onToggle }: QuietRunProps): JSX.Element {
  const overrides = useSenderToneStore((state) => state.overrides)

  // One face per sender rather than per thread: nine newsletters from three
  // brands is three things to recognise, not nine.
  const faces = [
    ...new Map(
      threads.map((thread) => [identityKey(parseSender(thread.from).address), thread])
    ).values()
  ].slice(0, 4)

  return (
    <button type="button" className={styles.quietBar} aria-expanded={expanded} onClick={onToggle}>
      <span className={styles.quietFaces} aria-hidden="true">
        {faces.map((thread) => {
          const sender = parseSender(thread.from)
          return (
            <span
              key={thread.id}
              className={`${styles.quietFace} ${TONE_CLASS[toneFor(overrides, sender.address)]}`}
            >
              {senderInitial(sender)}
            </span>
          )
        })}
      </span>
      <span className={styles.quietLabel}>
        {expanded ? 'Hide bulk mail' : describeQuietRun(threads)}
      </span>
      <span className={styles.quietRule} />
      <Icon
        name="chevron-down"
        size={14}
        className={`${styles.quietChevron} ${expanded ? styles.quietChevronOpen : ''}`}
      />
    </button>
  )
}

interface IconActionProps {
  label: string
  icon: Parameters<typeof Icon>[0]['name']
  disabled: boolean
  onClick: () => void
}

function IconAction({ label, icon, disabled, onClick }: IconActionProps): JSX.Element {
  return (
    <button
      type="button"
      className={styles.iconAction}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={15} />
    </button>
  )
}

interface ThreadReaderProps {
  summary: EmailThreadSummary | null
  messages: EmailMessage[]
  loading: boolean
  onClose: () => void
  /** True when the assistant rail is on screen to receive the instruction. */
  assistInRail: boolean
  /** True when the window is wide enough for the rail but the user hid it. */
  railHidden: boolean
  onShowRail: () => void
}

function ThreadReader({
  summary,
  messages,
  loading,
  onClose,
  assistInRail,
  railHidden,
  onShowRail
}: ThreadReaderProps): JSX.Element {
  const openEmailThreadConversation = useChatStore((s) => s.openEmailThreadConversation)
  const setPendingComposerText = useChatStore((s) => s.setPendingComposerText)
  const setView = useUiStore((s) => s.setView)

  /**
   * Writes the instruction into a composer rather than sending it. The model
   * drafts through `reply_email`, which keeps the existing approval gate in
   * front of anything actually being sent, and the user still gets to edit or
   * drop the instruction first.
   *
   * With the rail on screen that composer is right there and the rail has
   * already linked the thread's chat, so nothing else is needed. On a window
   * too narrow for the rail this falls back to the Chat page, which is the
   * only other place the conversation can happen.
   */
  const assist = (instruction: string, message: EmailMessage): void => {
    if (assistInRail) {
      setPendingComposerText(instruction)
      return
    }
    // The ids come along because the email tools address messages by id, not by
    // subject — without them the model would have to search the mailbox again
    // and might well act on the wrong message.
    setPendingComposerText(
      [
        instruction,
        '',
        `It is the message "${message.subject}" from ${message.from}.`,
        `Use account ${message.accountId}, messageId ${message.id}, threadId ${message.threadId}.`
      ].join('\n')
    )
    // Returns to the chat already discussing this thread when one is still
    // around, so a second Reply click continues the conversation rather than
    // starting a parallel one that has lost all the earlier context.
    openEmailThreadConversation(message.accountId, message.threadId, {
      subject: message.subject,
      latestMessageId: message.id
    })
    setView('chat')
  }

  const latest = messages[messages.length - 1]

  return (
    <>
      {/* Outside the scrolling body, and rendered while loading too: with the
          list gone, this bar is the only way back to the inbox, so it must
          neither scroll out of reach nor vanish while a slow mailbox opens. */}
      <div className={styles.readerHeader}>
        <Button
          variant="secondary"
          size="sm"
          onClick={onClose}
          iconLeft={<Icon name="chevron-left" size={14} />}
        >
          Inbox
        </Button>
        <div className={styles.readerActions}>
          {latest && (
            <>
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<Icon name="chat" size={14} />}
                onClick={() => assist('Summarize this email thread for me.', latest)}
              >
                Summarize
              </Button>
              <Button
                variant="primary"
                size="sm"
                iconLeft={<Icon name="pencil" size={14} />}
                onClick={() =>
                  assist('Draft a reply to this email and send it once I approve.', latest)
                }
              >
                Reply
              </Button>
            </>
          )}
          {railHidden && (
            <button
              type="button"
              className={styles.iconAction}
              onClick={onShowRail}
              title="Show the assistant"
              aria-label="Show the assistant"
            >
              <Icon name="panel-right" size={15} />
            </button>
          )}
        </div>
      </div>

      <div className={styles.reader}>
        {/* The list row already showed the subject, so carrying it through the
            load keeps the reader recognisable instead of blanking to a
            spinner and back. */}
        <h3 className={styles.readerSubject}>
          {summary?.subject ?? latest?.subject ?? '(no subject)'}
        </h3>

        {loading ? (
          <div className={styles.emptyInbox}>
            <p>Opening conversation…</p>
          </div>
        ) : messages.length === 0 ? (
          <div className={styles.emptyInbox}>
            <p>This conversation has no readable messages.</p>
          </div>
        ) : (
          <div className={styles.messageList}>
            {messages.map((message) => (
              <article key={message.id} className={styles.message}>
                <div className={styles.messageMeta}>
                  <strong>{message.from}</strong>
                  <span>{new Date(message.date).toLocaleString()}</span>
                </div>
                {message.to.length > 0 && (
                  <div className={styles.messageRecipients}>To: {message.to.join(', ')}</div>
                )}
                {message.bodyHtml ? (
                  <HtmlMessageBody html={message.bodyHtml} />
                ) : (
                  <div className={styles.messageBody}>
                    {message.body.trim() || message.snippet || '(no readable body)'}
                  </div>
                )}
                {message.attachments.length > 0 && (
                  <div className={styles.attachmentRow}>
                    {message.attachments.map((attachment) => (
                      <AttachmentChip
                        key={attachment.id}
                        attachment={attachment}
                        accountId={message.accountId}
                      />
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

interface AttachmentChipProps {
  attachment: EmailAttachmentSummary
  accountId: string
}

/** An attachment the user can actually get at, rather than just read the name of. */
function AttachmentChip({ attachment, accountId }: AttachmentChipProps): JSX.Element {
  const [saving, setSaving] = useState(false)
  const notify = useUiStore((s) => s.notify)

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await anodex.email.saveAttachment({
        messageId: attachment.messageId,
        attachmentId: attachment.id,
        filename: attachment.filename,
        accountId
      })
      if (!result.ok) {
        notifyError('Could not save attachment', result.error.detail ?? result.error.message)
        return
      }
      // A null path means the save dialog was dismissed, which is not an event
      // worth announcing.
      if (result.value.path) {
        notify({ kind: 'success', title: 'Attachment saved', message: result.value.path })
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <button
      type="button"
      className={styles.attachmentChip}
      disabled={saving}
      title={`Save ${attachment.filename}`}
      onClick={() => void handleSave()}
    >
      <Icon name={saving ? 'refresh' : 'download'} size={13} />
      {attachment.filename}
      <small>{formatBytes(attachment.size)}</small>
    </button>
  )
}

/** Inbox first, then the mailboxes people actually switch to, then the rest. */
function orderMailboxes(mailboxes: EmailMailbox[]): EmailMailbox[] {
  const rank = (name: string): number => {
    const key = friendlyMailboxName(name).toLowerCase()
    const order = ['inbox', 'sent', 'drafts', 'archive', 'all mail', 'starred', 'spam', 'trash']
    const index = order.indexOf(key)
    return index === -1 ? order.length : index
  }
  return [...mailboxes]
    .sort(
      (left, right) => rank(left.name) - rank(right.name) || left.name.localeCompare(right.name)
    )
    .slice(0, 8)
}

/** Strips the server's namespace prefix, e.g. `[Gmail]/Sent Mail` -> `Sent Mail`. */
function friendlyMailboxName(name: string): string {
  const trimmed = name.replace(/^\[[^\]]+\][/.]?/, '').trim()
  const leaf = trimmed.split(/[/.]/).pop()?.trim()
  return leaf || name
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
