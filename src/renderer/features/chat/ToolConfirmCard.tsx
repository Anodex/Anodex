import { useEffect, useState } from 'react'
import type {
  EmailDraftPreview,
  ToolConfirmRequest,
  ToolConfirmResponse
} from '@shared/tools.types'
import { useUiStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { confirmationsForConversation } from '../../stores/pendingConfirmations'
import { Icon } from '../../components/Icon'
import { DiffView } from './DiffView'
import { DiffStat } from './ToolCallCard'
import { confirmCardPresentation } from './confirmCardPresentation'
import styles from './ToolConfirmCard.module.css'

/**
 * Inline approval card(s) shown above the composer when the AI wants to write
 * a file, run a command, or search the web (and approval is required).
 * `pendingConfirmations` is a queue, not a single slot — node-llama-cpp (and
 * the cloud providers) can genuinely invoke multiple guarded tool calls
 * concurrently within one turn, so this renders one card for a single pending
 * request (unchanged from before) or a batch view with per-item and
 * approve-all/deny-all actions when more than one is pending at once.
 *
 * `pendingConfirmations` itself is a single global queue shared across every
 * conversation, though — nothing stops a second conversation from adding its
 * own request to it while the user is looking at a different one. Filtered
 * to the conversation actually on screen so a mixed batch never renders (the
 * cards carry no per-conversation label, so it would look like one batch)
 * and "Approve all"/"Deny all" can never reach into a conversation the user
 * isn't even looking at.
 */
export function ToolConfirmCard(): JSX.Element | null {
  const pendingConfirmations = useUiStore((s) => s.pendingConfirmations)
  const activeConversationId = useChatStore((s) => s.activeId)
  const resolve = useUiStore((s) => s.resolveConfirmation)
  const diffViewMode = useSettingsStore((s) => s.settings?.appearance.diffView ?? 'unified')

  const visible = confirmationsForConversation(pendingConfirmations, activeConversationId)
  if (visible.length === 0) return null

  const isBatch = visible.length > 1

  return (
    <div className={styles.stack}>
      {isBatch && (
        <div className={styles.batchHeader}>
          <span className={styles.batchTitle}>{visible.length} changes want your approval</span>
          <div className={styles.batchActions}>
            <button
              type="button"
              className={styles.batchDeny}
              onClick={() => visible.forEach((request) => resolve(request.id, { approved: false }))}
            >
              Deny all
            </button>
            <button
              type="button"
              className={styles.batchApprove}
              onClick={() => visible.forEach((request) => resolve(request.id, { approved: true }))}
            >
              Approve all
            </button>
          </div>
        </div>
      )}
      {visible.map((request) => (
        <ConfirmItem
          key={request.id}
          request={request}
          diffViewMode={diffViewMode}
          // Escape-to-deny only makes sense when there's exactly one pending
          // item to target — with several pending, which one Escape should
          // resolve is ambiguous, so the shortcut is omitted in favor of the
          // explicit approve-all/deny-all buttons above.
          listenForEscape={!isBatch}
          onResolve={(response) => resolve(request.id, response)}
        />
      ))}
    </div>
  )
}

interface ConfirmItemProps {
  request: ToolConfirmRequest
  diffViewMode: 'unified' | 'sideBySide'
  listenForEscape: boolean
  onResolve: (response: ToolConfirmResponse) => void
}

function ConfirmItem({
  request,
  diffViewMode,
  listenForEscape,
  onResolve
}: ConfirmItemProps): JSX.Element {
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (!listenForEscape) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (denying) setDenying(false)
      else onResolve({ approved: false })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [listenForEscape, denying, onResolve])

  const draft = request.emailDraft
  const config = confirmCardPresentation(request)

  return (
    <div
      className={`${styles.card} ${draft ? styles.draftCard : ''}`}
      role="dialog"
      aria-label={config.title}
    >
      <div className={styles.header}>
        <span className={`${styles.badge} ${styles[config.style]}`}>
          <Icon name={config.icon} size={14} />
        </span>
        <span className={styles.title}>{config.title}</span>
        {request.diff && <DiffStat before={request.diff.before} after={request.diff.after} />}
        {draft && <span className={styles.unsentBadge}>Not sent</span>}
        {request.risk === 'destructive' && <span className={styles.riskBadge}>Destructive</span>}
      </div>

      {request.turnGate && (
        <p className={styles.turnGateNote}>
          Approving lets the rest of this turn continue without asking again.
        </p>
      )}

      {draft ? (
        <EmailDraftBody draft={draft} />
      ) : request.diff ? (
        <div className={styles.diffWrap}>
          <DiffView
            before={request.diff.before}
            after={request.diff.after}
            mode={diffViewMode}
            path={request.diff.path}
          />
        </div>
      ) : (
        <pre className={styles.detail}>{request.detail}</pre>
      )}

      {denying ? (
        <div className={styles.denyRow}>
          <input
            autoFocus
            className={styles.reasonInput}
            value={reason}
            placeholder={
              draft ? 'What should it say instead?' : 'Optional: tell it what to do differently…'
            }
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onResolve({ approved: false, reason })
            }}
          />
          <button className={styles.cancelDeny} onClick={() => setDenying(false)}>
            Cancel
          </button>
          <button
            className={styles.confirmDeny}
            onClick={() => onResolve({ approved: false, reason })}
          >
            {draft ? 'Send back' : 'Deny'}
          </button>
        </div>
      ) : (
        <div className={styles.actions}>
          <button className={styles.deny} onClick={() => onResolve({ approved: false })}>
            {draft ? 'Discard' : 'Deny'}
          </button>
          {draft ? (
            // No "always allow" for mail. `send_email` and `reply_email` are
            // `requiresHumanApproval` tools precisely because each message is
            // its own decision that cannot be taken back — a remembered
            // approval would be a standing permission to send.
            <button className={styles.rememberApprove} onClick={() => setDenying(true)}>
              Revise
            </button>
          ) : (
            <button
              className={styles.rememberApprove}
              onClick={() => onResolve({ approved: true, remember: true })}
            >
              Always allow {request.toolName}
            </button>
          )}
          <button className={styles.approve} onClick={() => onResolve({ approved: true })}>
            <Icon name={draft ? 'send' : 'check'} size={14} />
            {config.approveLabel}
          </button>
        </div>
      )}
    </div>
  )
}

/** The message itself, laid out the way mail is read rather than as tool detail. */
function EmailDraftBody({ draft }: { draft: EmailDraftPreview }): JSX.Element {
  return (
    <div className={styles.draftBody}>
      <dl className={styles.draftFields}>
        <dt>To</dt>
        <dd>{draft.to.join(', ')}</dd>
        {draft.cc && (
          <>
            <dt>Cc</dt>
            <dd>{draft.cc.join(', ')}</dd>
          </>
        )}
        {draft.bcc && (
          <>
            <dt>Bcc</dt>
            <dd>{draft.bcc.join(', ')}</dd>
          </>
        )}
        <dt>Subject</dt>
        <dd>{draft.subject}</dd>
        {draft.attachmentNames && (
          <>
            <dt>Attached</dt>
            <dd>{draft.attachmentNames.join(', ')}</dd>
          </>
        )}
      </dl>
      <div className={styles.draftText}>{draft.body}</div>
    </div>
  )
}
