import { useState } from 'react'
import { Overlay } from '../../components/ui/Overlay'
import { Button } from '../../components/ui/Button'
import { Icon } from '../../components/Icon'
import { useEmailStore } from '../../stores/emailStore'
import { canSend } from './composeMail'
import styles from './EmailComposer.module.css'

/**
 * Writing a message at the computer.
 *
 * This app could read mail, file it, delete it and ask the model to answer it —
 * and could not send three words without a model writing them, while the phone
 * could. The window is the phone's, deliberately: the same fields in the same
 * order, and **Have Anodex write it** inside the window rather than instead of
 * it. The model is an option in your compose window, not the only door out.
 *
 * The instruction to the model is kept apart from the body it writes. Merging
 * them means the thing you typed to steer it becomes part of what gets sent,
 * which is only noticed after it has been sent.
 */
export function EmailComposer(): JSX.Element | null {
  const draft = useEmailStore((s) => s.composing)
  const sending = useEmailStore((s) => s.sending)
  const writing = useEmailStore((s) => s.writing)
  const update = useEmailStore((s) => s.updateCompose)
  const close = useEmailStore((s) => s.closeCompose)
  const send = useEmailStore((s) => s.sendCompose)
  const writeBody = useEmailStore((s) => s.writeBody)

  const [instruction, setInstruction] = useState('')
  const [asking, setAsking] = useState(false)
  // Armed rather than immediate: closing loses what is typed, and a window with
  // a paragraph in it is worth one more click to throw away.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  if (!draft) return null

  const written = draft.body.trim() !== '' || draft.to.trim() !== '' || draft.subject.trim() !== ''

  const discard = (): void => {
    if (!written || confirmingDiscard) close()
    else setConfirmingDiscard(true)
  }

  return (
    <Overlay onClose={discard} ariaLabel={draft.kind} cardClassName={styles.card}>
      <header className={styles.header}>
        <h2 className={styles.title}>{draft.kind}</h2>
        <Button variant="ghost" size="sm" onClick={discard}>
          {confirmingDiscard ? 'Click again to discard' : 'Discard'}
        </Button>
      </header>

      <div className={styles.fields}>
        <label className={styles.field}>
          <span className={styles.label}>To</span>
          <input
            className={styles.input}
            value={draft.to}
            autoFocus={draft.to === ''}
            placeholder="someone@example.com"
            onChange={(event) => update({ ...draft, to: event.target.value })}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Cc</span>
          <input
            className={styles.input}
            value={draft.cc}
            placeholder="Nobody else"
            onChange={(event) => update({ ...draft, cc: event.target.value })}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Subject</span>
          <input
            className={styles.input}
            value={draft.subject}
            onChange={(event) => update({ ...draft, subject: event.target.value })}
          />
        </label>
      </div>

      <textarea
        className={styles.body}
        value={draft.body}
        autoFocus={draft.to !== '' && draft.body === ''}
        placeholder="Write your message"
        onChange={(event) => update({ ...draft, body: event.target.value })}
      />

      <div className={styles.assist}>
        {asking ? (
          <>
            <input
              className={styles.input}
              value={instruction}
              autoFocus
              placeholder="What should it say?"
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !writing) void writeBody(instruction)
              }}
            />
            <div className={styles.assistActions}>
              <Button variant="ghost" size="sm" onClick={() => setAsking(false)} disabled={writing}>
                Never mind
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={writing}
                onClick={() => void writeBody(instruction)}
              >
                {writing ? 'Writing…' : 'Write it'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Icon name="pencil" size={13} />}
              onClick={() => setAsking(true)}
            >
              {draft.body.trim() ? 'Have Anodex rewrite it' : 'Have Anodex write it'}
            </Button>
            <span className={styles.assistNote}>It writes a draft. You send it.</span>
          </>
        )}
      </div>

      <footer className={styles.footer}>
        <span className={styles.sendNote}>
          {canSend(draft)
            ? 'Sent from this computer, using the account connected here.'
            : 'Needs a recipient, a subject and something to say.'}
        </span>
        <Button
          variant="primary"
          size="sm"
          disabled={!canSend(draft) || sending}
          iconLeft={<Icon name="send" size={13} />}
          onClick={() => void send()}
        >
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </footer>
    </Overlay>
  )
}
