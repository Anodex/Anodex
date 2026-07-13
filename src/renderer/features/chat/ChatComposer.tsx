import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { messageToHistoryTurn } from '@shared/chatSanitizer'
import type { SkillSummary } from '@shared/skill.types'
import type { PermissionMode } from '@shared/settings.types'
import { planManualContextCompaction } from '@shared/contextProjection'
import { useChatStore, type PendingMessage } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useProjectStore } from '../../stores/projectStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { notifyError } from '../../stores/uiStore'
import { isChatReady } from '../../lib/chatReadiness'
import { Icon, type IconName } from '../../components/Icon'
import { FileTypeIcon } from '../../components/FileTypeIcon'
import { anodex } from '../../lib/anodex'
import { ANODEX_FILE_DRAG_TYPE, type ComposerAttachment } from '../../lib/attachments'
import { formatBytes } from '../../lib/format'
import {
  applySkillSuggestion,
  getAppliedSkillName,
  getSkillSuggestions
} from '../../lib/skillSuggestions'
import { WorkspaceControl } from './WorkspaceControl'
import { ContextTransparencyPanel } from './ContextTransparencyPanel'
import { ContextMeter } from './ContextMeter'
import { ToolConfirmCard } from './ToolConfirmCard'
import {
  completeSlashCommand,
  expandSlashCommand,
  getSlashCommandSuggestions,
  SLASH_COMMAND_HINT,
  type SlashCommandName
} from '../../lib/slashCommands'
import styles from './ChatComposer.module.css'

const MAX_TEXTAREA_HEIGHT = 200
/** Keeps a single turn's attached content bounded — mirrors the old read_file cap. */
const MAX_ATTACHMENTS = 10
// Stable reference for the no-queue case — a fresh `[]` literal in the
// selector would give useSyncExternalStore a new snapshot on every call,
// which React treats as "state changed every render" and throws "Maximum
// update depth exceeded".
const EMPTY_QUEUE: PendingMessage[] = []
const EMPTY_SKILL_NAMES: string[] = []

function permissionIcon(mode: PermissionMode): IconName {
  if (mode === 'untethered') return 'unlock-keyhole'
  if (mode === 'full') return 'shield-check'
  return 'shield-question'
}

function permissionLabel(mode: PermissionMode): string {
  if (mode === 'untethered') return 'Untethered'
  if (mode === 'full') return 'Full'
  return 'Ask'
}

function permissionDescription(mode: PermissionMode): string {
  if (mode === 'untethered') return 'auto-runs safe and sensitive actions'
  if (mode === 'full') return 'auto-runs safe edits and asks before risky actions'
  return 'asks before writes and shell commands'
}

/** Auto-growing message input with send / stop controls and drag-and-drop file attachments. */
export function ChatComposer(): JSX.Element {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [activeSlashIndex, setActiveSlashIndex] = useState(0)
  const [compacting, setCompacting] = useState(false)
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [dismissedSkillName, setDismissedSkillName] = useState<string | null>(null)
  const [queueExpanded, setQueueExpanded] = useState(false)
  const dragCounter = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const activeConversation = useChatStore((s) => s.conversations.find((c) => c.id === s.activeId))
  const sendMessage = useChatStore((s) => s.sendMessage)
  const queueMessage = useChatStore((s) => s.queueMessage)
  const removeQueuedMessage = useChatStore((s) => s.removeQueuedMessage)
  const pendingQueue = useChatStore((s) =>
    s.activeId ? (s.pendingMessages[s.activeId] ?? EMPTY_QUEUE) : EMPTY_QUEUE
  )
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const compactConversation = useChatStore((s) => s.compactConversation)
  const engine = useModelStore((s) => s.engine)
  const settings = useSettingsStore((s) => s.settings)
  const toolsEnabled = settings?.tools.enabled ?? true
  const permissionMode = settings?.general.permissionMode ?? 'ask'
  const projects = useProjectStore((s) => s.projects)
  const activeProject = projects.find((project) => project.id === activeConversation?.projectId)
  const pinnedSkillNames = activeProject?.pinnedSkillNames ?? EMPTY_SKILL_NAMES

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
  const hasContent = text.trim().length > 0 || attachments.length > 0
  const canSend = ready && !generating && hasContent
  // While generating, Enter/Send queues a comment instead of sending
  // immediately — the model can't be steered mid-turn, so it's held until the
  // current reply finishes rather than firing a second overlapping request.
  const canQueue = ready && generating && hasContent
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
  const slashSuggestions = useMemo(() => getSlashCommandSuggestions(text), [text])
  const showSlashSuggestions = ready && slashSuggestions.length > 0
  const selectedSlashSuggestion =
    slashSuggestions[Math.min(activeSlashIndex, slashSuggestions.length - 1)]
  const skillSuggestions = useMemo(
    () =>
      ready && !showSlashSuggestions
        ? getSkillSuggestions(skills, text, { limit: 2, pinnedSkillNames })
        : [],
    [ready, showSlashSuggestions, skills, text, pinnedSkillNames]
  )
  const appliedSkillName = getAppliedSkillName(text)
  const visibleSkillSuggestion =
    skillSuggestions.find(
      (skill) => skill.name !== dismissedSkillName && skill.name !== appliedSkillName
    ) ?? null
  const activeSkillNames = pinnedSkillNames.filter((name) =>
    skills.some((skill) => skill.name === name)
  )
  const showContextPanel =
    ready &&
    (Boolean(activeProject) ||
      activeSkillNames.length > 0 ||
      attachments.length > 0 ||
      Boolean(activeConversation?.context?.activeSnapshot))

  useEffect(() => {
    let cancelled = false
    void anodex.skills.list(activeConversation?.projectId ?? null).then((result) => {
      if (!cancelled) setSkills(result)
    })
    return () => {
      cancelled = true
    }
  }, [activeConversation?.projectId])

  useEffect(() => {
    setDismissedSkillName(null)
  }, [text])

  useEffect(() => {
    if (pendingQueue.length === 0) setQueueExpanded(false)
  }, [pendingQueue.length])

  const resetHeight = (): void => {
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const autoGrow = (): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }

  const expandComposerText = (value: string): string =>
    expandSlashCommand(value)?.expandedText ?? value

  const selectSlashCommand = (command: SlashCommandName): void => {
    setText(completeSlashCommand(text, command))
    setActiveSlashIndex(0)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      autoGrow()
    })
  }

  const applySuggestedSkill = (skillName: string): void => {
    setText((current) => applySkillSuggestion(skillName, current))
    setDismissedSkillName(skillName)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      autoGrow()
    })
  }

  const submit = (): void => {
    if (generating) {
      if (!canQueue) return
      const value = expandComposerText(text)
      const pendingAttachments = attachments
      setText('')
      setAttachments([])
      resetHeight()
      queueMessage(value, pendingAttachments)
      return
    }
    if (!canSend) return
    const value = expandComposerText(text)
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
    if (showSlashSuggestions) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveSlashIndex((index) => (index + 1) % slashSuggestions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveSlashIndex(
          (index) => (index - 1 + slashSuggestions.length) % slashSuggestions.length
        )
        return
      }
      if ((event.key === 'Tab' || event.key === 'Enter') && selectedSlashSuggestion) {
        event.preventDefault()
        selectSlashCommand(selectedSlashSuggestion.name)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setText('')
        setActiveSlashIndex(0)
        return
      }
    }

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

  const handleAttachClick = async (): Promise<void> => {
    if (!ready) return
    const picked = await anodex.attachments.pickFiles()
    if (picked.length > 0) void attachFiles(picked)
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

      {showContextPanel && (
        <ContextTransparencyPanel
          projectName={activeProject?.name ?? null}
          toolsEnabled={toolsEnabled}
          hasProjectInstructions={Boolean(activeProject?.instructions)}
          pinnedSkillNames={activeSkillNames}
          attachmentCount={attachments.length}
          hasContextSnapshot={Boolean(activeConversation?.context?.activeSnapshot)}
        />
      )}

      {pendingQueue.length > 0 && activeConversation && (
        <div className={styles.pendingWrap}>
          <button
            type="button"
            className={styles.pendingSummary}
            onClick={() => setQueueExpanded((value) => !value)}
            aria-expanded={queueExpanded}
          >
            <Icon name="clock" size={12} />
            <span className={styles.pendingSummaryText}>
              {pendingQueue.length} message{pendingQueue.length === 1 ? '' : 's'} queued
            </span>
            <Icon
              name="chevron-down"
              size={12}
              className={`${styles.pendingChevron} ${queueExpanded ? styles.pendingChevronOpen : ''}`}
            />
          </button>

          {queueExpanded && (
            <div className={styles.pendingQueue}>
              {pendingQueue.map((item) => (
                <div key={item.id} className={styles.pendingItem}>
                  <Icon name="clock" size={12} />
                  <span className={styles.pendingText}>
                    {item.text || `${item.attachments.length} file(s) attached`}
                  </span>
                  <button
                    type="button"
                    className={styles.pendingRemove}
                    onClick={() => removeQueuedMessage(activeConversation.id, item.id)}
                    aria-label="Remove queued message"
                    title="Remove — won't be sent"
                  >
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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

      {showSlashSuggestions && (
        <div className={styles.commandMenu} role="listbox" aria-label="Slash commands">
          <div className={styles.commandMenuHeader}>Slash commands</div>
          {slashSuggestions.map((command, index) => (
            <button
              key={command.name}
              type="button"
              className={`${styles.commandItem} ${index === activeSlashIndex ? styles.commandItemActive : ''}`}
              onMouseDown={(event) => {
                event.preventDefault()
                selectSlashCommand(command.name)
              }}
              role="option"
              aria-selected={index === activeSlashIndex}
            >
              <span className={styles.commandName}>/{command.name}</span>
              <span className={styles.commandDescription}>{command.description}</span>
            </button>
          ))}
        </div>
      )}

      {visibleSkillSuggestion && !generating && (
        <div className={styles.skillHint}>
          <Icon name="sparkle" size={13} />
          <span className={styles.skillHintText}>
            Relevant {visibleSkillSuggestion.scope} skill:{' '}
            <strong>{visibleSkillSuggestion.name}</strong>
          </span>
          <button
            type="button"
            className={styles.skillHintAction}
            onMouseDown={(event) => {
              event.preventDefault()
              applySuggestedSkill(visibleSkillSuggestion.name)
            }}
          >
            Use
          </button>
          <button
            type="button"
            className={styles.skillHintDismiss}
            aria-label="Dismiss skill suggestion"
            title="Dismiss"
            onMouseDown={(event) => {
              event.preventDefault()
              setDismissedSkillName(visibleSkillSuggestion.name)
            }}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      )}

      <div className={`${styles.inputRow} ${!ready ? styles.disabled : ''}`}>
        <button
          type="button"
          className={`${styles.action} ${styles.attach}`}
          onClick={() => void handleAttachClick()}
          disabled={!ready || attachments.length >= MAX_ATTACHMENTS}
          title="Attach files"
          aria-label="Attach files"
        >
          <Icon name="paperclip" size={16} />
        </button>

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
            setActiveSlashIndex(0)
            autoGrow()
          }}
          onKeyDown={handleKeyDown}
        />

        {generating && !hasContent ? (
          <button
            className={`${styles.action} ${styles.stop}`}
            onClick={() => void stopGeneration()}
            title="Stop generating"
            aria-label="Stop generating"
          >
            <Icon name="stop" size={15} />
          </button>
        ) : generating ? (
          <button
            className={`${styles.action} ${styles.send}`}
            onClick={submit}
            disabled={!canQueue}
            title="Send after the current reply finishes"
            aria-label="Queue message"
          >
            <Icon name="send" size={16} />
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
        <span
          className={[
            styles.permissionBadge,
            styles[`permission${permissionLabel(permissionMode)}`]
          ].join(' ')}
          title={`Permission mode: ${permissionLabel(permissionMode)} - ${permissionDescription(
            permissionMode
          )}`}
          aria-label={`Permission mode: ${permissionLabel(permissionMode)}`}
        >
          <Icon name={permissionIcon(permissionMode)} size={13} />
        </span>
      </div>
      <div className={styles.hint}>
        {generating
          ? `Enter to queue for after this reply · Shift+Enter for a new line · ${SLASH_COMMAND_HINT}`
          : `Enter to send · Shift+Enter for a new line · Drag or attach a file · Responses are generated locally · ${SLASH_COMMAND_HINT}`}
      </div>
    </div>
  )
}
