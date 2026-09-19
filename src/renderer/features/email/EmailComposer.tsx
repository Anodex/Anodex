import { useState } from 'react'
import { Overlay } from '../../components/ui/Overlay'
import { Button } from '../../components/ui/Button'
import { Icon } from '../../components/Icon'
import { useEmailStore } from '../../stores/emailStore'
import { attachedBytes, canSend, readableSize } from './composeMail'
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
  const attachFiles = useEmailStore((s) => s.attachFiles)
  const removeAttachment = useEmailStore((s) => s.removeAttachment)
  const attaching = useEmailStore((s) => s.attaching)

  const [instruction, setInstruction] = useState('')
  const [asking, setAsking] = useState(false)
  // Shown once asked for. Most messages copy nobody, and two empty fields
  // above the subject line make the window look like a form to fill in
  // rather than a place to write something.
  const [showingCopies, setShowingCopies] = useState(false)
  // Armed rather than immediate: closing loses what is typed, and a window with
  // a paragraph in it is worth one more click to throw away.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  if (!draft) return null

  const written =
    draft.body.trim() !== '' ||
    draft.to.trim() !== '' ||
    draft.subject.trim() !== '' ||
    draft.attachments.length > 0

  // Open if they were asked for, and open if a reply arrived with people
  // already on it -- a Cc that is populated and hidden is the version of this
  // that sends a message to somebody the writer did not know was included.
  const copiesOpen = showingCopies || draft.cc.trim() !== '' || draft.bcc.trim() !== ''

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

        {copiesOpen ? (
          <>
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
              <span className={styles.label}>Bcc</span>
              <input
                className={styles.input}
                value={draft.bcc}
                /* Said rather than implied. Everyone knows roughly what Bcc
                   does and almost nobody is certain, and the cost of being
                   wrong falls on people who are not in the room. */
                placeholder="Hidden from everyone else on the message"
                onChange={(event) => update({ ...draft, bcc: event.target.value })}
              />
            </label>
          </>
        ) : (
          <button
            type="button"
            className={styles.copiesToggle}
            onClick={() => setShowingCopies(true)}
          >
            Cc / Bcc
          </button>
        )}

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

      {draft.attachments.length > 0 && (
        <ul className={styles.attachments}>
          {draft.attachments.map((file) => (
            <li key={file.filename} className={styles.attachment}>
              <Icon name="paperclip" size={12} />
              <span className={styles.attachmentName} title={file.filename}>
                {file.filename}
              </span>
              <span className={styles.attachmentSize}>{readableSize(file.sizeBytes)}</span>
              <button
                type="button"
                className={styles.attachmentRemove}
                aria-label={`Remove ${file.filename}`}
                onClick={() => removeAttachment(file.filename)}
              >
                <Icon name="close" size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}

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
            <Button
              variant="ghost"
              size="sm"
              disabled={attaching}
              iconLeft={<Icon name="paperclip" size={13} />}
              onClick={() => void attachFiles()}
            >
              {attaching ? 'Choosing…' : 'Attach'}
            </Button>
            <span className={styles.assistNote}>It writes a draft. You send it.</span>
          </>
        )}
      </div>

      <footer className={styles.footer}>
        <span className={styles.sendNote}>
          {!canSend(draft)
            ? 'Needs a recipient, a subject and something to say.'
            : draft.attachments.length > 0
              ? `Sending ${draft.attachments.length} ${
                  draft.attachments.length === 1 ? 'file' : 'files'
                }, ${readableSize(attachedBytes(draft))} in all.`
              : 'Sent from this computer, using the account connected here.'}
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
