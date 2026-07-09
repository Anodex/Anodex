import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { messageToHistoryTurn } from '@shared/chatSanitizer'
import { planManualContextCompaction } from '@shared/contextProjection'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { notifyError } from '../../stores/uiStore'
import { isChatReady } from '../../lib/chatReadiness'
import { Icon } from '../../components/Icon'
import { FileTypeIcon } from '../../components/FileTypeIcon'
import { anodex } from '../../lib/anodex'
import { ANODEX_FILE_DRAG_TYPE, type ComposerAttachment } from '../../lib/attachments'
import { formatBytes } from '../../lib/format'
import { WorkspaceControl } from './WorkspaceControl'
import { ContextMeter } from './ContextMeter'
import { ToolConfirmCard } from './ToolConfirmCard'
import styles from './ChatComposer.module.css'

const MAX_TEXTAREA_HEIGHT = 200
/** Keeps a single turn's attached content bounded — mirrors the old read_file cap. */
const MAX_ATTACHMENTS = 10

/** Auto-growing message input with send / stop controls and drag-and-drop file attachments. */
export function ChatComposer(): JSX.Element {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const dragCounter = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const activeConversation = useChatStore((s) => s.conversations.find((c) => c.id === s.activeId))
  const sendMessage = useChatStore((s) => s.sendMessage)
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const compactConversation = useChatStore((s) => s.compactConversation)
  const engine = useModelStore((s) => s.engine)
  const settings = useSettingsStore((s) => s.settings)

  // Provider-aware: the Anthropic provider needs no loaded local model, only
  // a configured API key (see `isChatReady`). `localReady` is kept separate
  // because manual context compaction is always a local-engine feature (see
  // `chatStore.compactConversation`), regardless of which provider is active.
  const ready = isChatReady(settings, engine.status)
  const localReady = engine.status === 'ready'
  // Driven off the active conversation's own streaming message rather than
  // the local engine's `generating` flag, which the Anthropic provider never
  // touches — this way Send/Stop toggles correctly for either provider.
  const generating = activeConversation?.messages.some((m) => m.streaming) ?? false
  const canSend = ready && !generating && (text.trim().length > 0 || attachments.length > 0)
  // Mirrors the real eligibility check `compactConversation` sends to the main
  // process (via `planManualContextCompaction`), instead of a raw message-count
  // heuristic that ignores an already-applied snapshot — that heuristic could
  // leave the button enabled with nothing actually left to compact.
  //
  // Skipped entirely while generating: the store gives the active conversation
  // a new object reference on every streamed token (see `appendToken`), which
  // would otherwise defeat this memo and re-run the full-history scan on every
  // token — for a value that's already forced to `false` below regardless.
  const hasCompactableHistory = useMemo(() => {
    if (!activeConversation || generating) return false
    return (
      planManualContextCompaction(
        activeConversation.messages.map(messageToHistoryTurn),
        activeConversation.context
      ) != null
    )
  }, [activeConversation, generating])
  const canCompact = localReady && !generating && !compacting && hasCompactableHistory

  const resetHeight = (): void => {
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const autoGrow = (): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }

  const submit = (): void => {
    if (!canSend) return
    const value = text
    const pendingAttachments = attachments
    setText('')
    setAttachments([])
    resetHeight()
    void sendMessage(value, pendingAttachments)
  }

  const compact = async (): Promise<void> => {
    if (!canCompact) return
    setCompacting(true)
    try {
      await compactConversation()
    } finally {
      setCompacting(false)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const removeAttachment = (path: string): void => {
    setAttachments((prev) => prev.filter((a) => a.path !== path))
  }

  const attachFiles = async (candidates: { path: string; name: string }[]): Promise<void> => {
    let currentCount = attachments.length
    const seenPaths = new Set(attachments.map((a) => a.path))
    for (const { path, name } of candidates) {
      if (currentCount >= MAX_ATTACHMENTS) {
        notifyError('Too many attachments', `Only the first ${MAX_ATTACHMENTS} files were added.`)
        break
      }
      if (seenPaths.has(path)) continue
      const result = await anodex.attachments.readFile(path)
      if (!result.ok) {
        notifyError('Could not attach file', result.error.message)
        continue
      }
      seenPaths.add(path)
      currentCount += 1
      const { content, sizeBytes, truncated } = result.value
      setAttachments((prev) => [...prev, { path, name, content, sizeBytes, truncated }])
    }
  }

  const handleDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragCounter.current += 1
    setDragActive(true)
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
  }

  const handleDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragCounter.current = Math.max(0, dragCounter.current - 1)
    if (dragCounter.current === 0) setDragActive(false)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragCounter.current = 0
    setDragActive(false)
    if (!ready) return

    const internalPayload = event.dataTransfer.getData(ANODEX_FILE_DRAG_TYPE)
    if (internalPayload) {
      try {
        const { path, name } = JSON.parse(internalPayload) as { path: string; name: string }
        void anodex.workspace.getAbsolutePath(path).then((resolved) => {
          if (resolved.ok) void attachFiles([{ path: resolved.value, name }])
          else notifyError('Could not attach file', resolved.error.message)
        })
      } catch {
        /* Malformed internal drag payload — ignore. */
      }
      return
    }

    const dropped = Array.from(event.dataTransfer.files)
      .map((file) => ({ path: anodex.system.getPathForFile(file), name: file.name }))
      .filter((candidate) => candidate.path)
    if (dropped.length > 0) void attachFiles(dropped)
  }

  return (
    <div
      className={`${styles.composer} ${dragActive ? styles.dragActive : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <ToolConfirmCard />
      <WorkspaceControl />

      {attachments.length > 0 && (
        <div className={styles.attachments}>
          {attachments.map((attachment) => (
            <div key={attachment.path} className={styles.attachment} title={attachment.path}>
              <FileTypeIcon fileName={attachment.name} size={13} />
              <span className={styles.attachmentName}>{attachment.name}</span>
              <span className={styles.attachmentSize}>{formatBytes(attachment.sizeBytes)}</span>
              <button
                type="button"
                className={styles.attachmentRemove}
                onClick={() => removeAttachment(attachment.path)}
                aria-label={`Remove ${attachment.name}`}
                title="Remove"
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className={`${styles.inputRow} ${!ready ? styles.disabled : ''}`}>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={text}
          rows={1}
          disabled={!ready}
          spellCheck={true}
          placeholder={
            dragActive
              ? 'Drop to attach…'
              : ready
                ? 'Message Anodex…'
                : settings?.provider.active === 'anthropic'
                  ? 'Add a Claude API key in Settings → AI & Models to start chatting'
                  : settings?.provider.active === 'openai'
                    ? 'Add an OpenAI API key in Settings → AI & Models to start chatting'
                    : 'Load a model from the Models tab to start chatting'
          }
          onChange={(event) => {
            setText(event.target.value)
            autoGrow()
          }}
          onKeyDown={handleKeyDown}
        />

        {generating ? (
          <button
            className={`${styles.action} ${styles.stop}`}
            onClick={() => void stopGeneration()}
            title="Stop generating"
            aria-label="Stop generating"
          >
            <Icon name="stop" size={15} />
          </button>
        ) : (
          <button
            className={`${styles.action} ${styles.send}`}
            onClick={submit}
            disabled={!canSend}
            title="Send message"
            aria-label="Send message"
          >
            <Icon name="send" size={16} />
          </button>
        )}
      </div>
      <div className={styles.contextRow}>
        <button
          type="button"
          className={styles.compactAction}
          onClick={() => void compact()}
          disabled={!canCompact}
          title="Compact chat context"
          aria-label="Compact chat context"
        >
          <Icon name={compacting ? 'refresh' : 'archive'} size={13} />
        </button>
        <ContextMeter className={styles.contextMeter} />
      </div>
      <div className={styles.hint}>
        Enter to send · Shift+Enter for a new line · Drag a file in to attach it · Responses are
        generated locally
      </div>
    </div>
  )
}
