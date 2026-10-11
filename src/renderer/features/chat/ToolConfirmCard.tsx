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
              // A key box is skipped: approving it in bulk can only send it
              // back empty, which reads as the person not having a key.
              onClick={() =>
                visible
                  .filter((request) => !request.secret)
                  .forEach((request) => resolve(request.id, { approved: true }))
              }
            >
              Approve all
            </button>
          </div>
        </div>
      )}
      {visible.map((request) =>
        request.secret ? (
          <SecretItem
            key={request.id}
            request={request}
            secret={request.secret}
            onResolve={(response) => resolve(request.id, response)}
          />
        ) : request.choices ? (
          <ChoicesItem
            key={request.id}
            request={request}
            choices={request.choices}
            onResolve={(response) => resolve(request.id, response)}
          />
        ) : (
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
        )
      )}
    </div>
  )
}

/**
 * A list to tick, in place of a yes/no: everything starts ticked, and what is
 * left ticked is what goes. See `move_to_trash`.
 */
function ChoicesItem({
  request,
  choices,
  onResolve
}: {
  request: ToolConfirmRequest
  choices: NonNullable<ToolConfirmRequest['choices']>
  onResolve: (response: ToolConfirmResponse) => void
}): JSX.Element {
  const [ticked, setTicked] = useState(() => new Set(choices.map((choice) => choice.id)))
  const toggle = (id: string): void =>
    setTicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <div className={styles.card} role="dialog" aria-label={request.title}>
      <div className={styles.header}>
        <span className={`${styles.badge} ${styles.write}`}>
          <Icon name="trash" size={14} />
        </span>
        <span className={styles.title}>{request.title}</span>
      </div>
      <p className={styles.secretHelp}>{request.detail}</p>
      <ul className={styles.choiceList}>
        {choices.map((choice) => (
          <li key={choice.id}>
            <label className={styles.choice}>
              <input
                type="checkbox"
                checked={ticked.has(choice.id)}
                onChange={() => toggle(choice.id)}
              />
              <span className={styles.choiceText}>
                <span className={styles.choiceLabel}>{choice.label}</span>
                {choice.detail && <span className={styles.choiceDetail}>{choice.detail}</span>}
              </span>
              {choice.size && <span className={styles.choiceSize}>{choice.size}</span>}
            </label>
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <button className={styles.deny} onClick={() => onResolve({ approved: false })}>
          Cancel
        </button>
        <button
          className={styles.approve}
          disabled={ticked.size === 0}
          onClick={() =>
            onResolve({
              approved: true,
              chosenIds: choices
                .filter((choice) => ticked.has(choice.id))
                .map((choice) => choice.id)
            })
          }
        >
          <Icon name="trash" size={14} />
          {ticked.size === choices.length ? 'Move all to Trash' : `Move ${ticked.size} to Trash`}
        </button>
      </div>
    </div>
  )
}

/**
 * A box to paste a key into, in place of a yes/no. The key goes back to the
 * main process with the answer, where it is checked and stored encrypted; the
 * model is told only whether it worked. See `request_key`.
 */
function SecretItem({
  request,
  secret,
  onResolve
}: {
  request: ToolConfirmRequest
  secret: NonNullable<ToolConfirmRequest['secret']>
  onResolve: (response: ToolConfirmResponse) => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const entered = value.trim()
  const save = (): void => {
    if (entered) onResolve({ approved: true, secretValue: entered })
  }
  return (
    <div className={styles.card} role="dialog" aria-label={request.title}>
      <div className={styles.header}>
        <span className={`${styles.badge} ${styles.write}`}>
          <Icon name="unlock-keyhole" size={14} />
        </span>
        <span className={styles.title}>{request.title}</span>
      </div>
      <p className={styles.secretHelp}>
        {secret.getUrl ? (
          <>
            Get one at{' '}
            <a href={secret.getUrl} target="_blank" rel="noreferrer">
              {secret.getUrl.replace(/^https:\/\//, '')}
            </a>
            , then paste it here.
          </>
        ) : (
          'Paste it here.'
        )}{' '}
        It is checked, then stored encrypted on this computer. Anodex never sees it.
      </p>
      <form
        className={styles.secretRow}
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        <input
          className={styles.secretInput}
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          aria-label={`${secret.service} key`}
          placeholder={secret.placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          type="button"
          className={styles.deny}
          onClick={() => onResolve({ approved: false })}
        >
          Not now
        </button>
        <button type="submit" className={styles.approve} disabled={!entered}>
          <Icon name="check" size={14} />
          Save key
        </button>
      </form>
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
