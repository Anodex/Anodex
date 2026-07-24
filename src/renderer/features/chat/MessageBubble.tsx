import { useEffect, useState } from 'react'
import type { ChatMessage } from '@shared/chat.types'
import { AnodexLogo } from '../../components/AnodexLogo'
import { Icon } from '../../components/Icon'
import { formatClock } from '../../lib/format'
import { savePendingSkillEditorDraft } from '../../lib/skillEditorDraftHandoff'
import { buildSkillDraft } from '../../lib/skillDraft'
import { useChatStore } from '../../stores/chatStore'
import { useUiStore } from '../../stores/uiStore'
import { MemoryUsedCard } from './MemoryUsedCard'
import { TranscriptRecallCard } from './TranscriptRecallCard'
import { MessageContent } from './MessageContent'
import { ThinkingIndicator } from './ThinkingIndicator'
import { TurnRecap } from './TurnRecap'
import { CheckpointDialog } from './CheckpointDialog'
import { EditMessageDialog } from './EditMessageDialog'
import { MessageAttachments } from './MessageAttachments'
import { buildRenderSegments, groupSegmentsForTimeline, messageBlocks } from './taskPhase'
import styles from './MessageBubble.module.css'

/**
 * A single chat turn. Roles read from the silhouette: user turns are
 * right-aligned bubbles with no author line, assistant turns are flat,
 * full-width text under a compact identity row. Secondary actions (copy,
 * draft skill, stats, timestamps for user turns) live in a hover-revealed
 * footer instead of permanent chrome.
 */
export function MessageBubble({
  message,
  previousUserContent,
  conversationStreaming,
  firstLight = false
}: {
  message: ChatMessage
  previousUserContent?: string
  /**
   * Whether any message in this conversation is currently streaming — only
   * ever the newest assistant reply (messages are appended, never inserted
   * mid-list). Computed once by `MessageList` from the `messages` prop it
   * already has, instead of every bubble independently re-scanning the whole
   * conversation from the store on every streamed token.
   */
  conversationStreaming: boolean
  /**
   * This is the conversation's first assistant turn. If this mount also
   * witnesses its thinking → first-words handoff, the reply arrives with the
   * one-shot "first light" (sparkle flare + a band of light over the words).
   * History mounts arrive with content already present and never play it.
   */
  firstLight?: boolean
}): JSX.Element {
  const isUser = message.role === 'user'
  const openSettings = useUiStore((s) => s.openSettings)
  const notify = useUiStore((s) => s.notify)
  const activeConversationId = useChatStore((s) => s.activeId)
  const [copied, setCopied] = useState(false)
  const [draftOpened, setDraftOpened] = useState(false)
  const [checkpointOpen, setCheckpointOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const showCopy = !message.streaming && message.content.length > 0
  const showSkillDraft =
    !isUser &&
    !message.streaming &&
    message.content.length > 0 &&
    (message.toolCalls?.some((call) => call.status === 'success') ?? false)
  const showCheckpoint =
    !isUser &&
    !message.streaming &&
    Boolean(message.checkpoint?.changedFiles.length) &&
    Boolean(activeConversationId)

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* Clipboard unavailable — silently ignore. */
    }
  }

  const handleDraftSkill = (): void => {
    try {
      const draft = buildSkillDraft({
        userPrompt: previousUserContent || 'Workflow from chat',
        assistantContent: message.content,
        toolNames: message.toolCalls?.map((call) => call.name) ?? []
      })
      savePendingSkillEditorDraft(sessionStorage, draft)
      setDraftOpened(true)
      openSettings('projects')
      notify({
        kind: 'success',
        title: 'Skill draft opened',
        message: 'Review and save it from the project skill library.'
      })
      setTimeout(() => setDraftOpened(false), 1500)
    } catch {
      /* Storage unavailable — silently ignore. */
    }
  }

  const segments = buildRenderSegments(messageBlocks(message))
  const showThinking = message.streaming && segments.length === 0
  const lastSegment = segments[segments.length - 1]
  const timeline = groupSegmentsForTimeline(segments)
  // The tail of a streaming message should always carry a live signal. A text
  // tail gets the caret below; a tool group with a running call animates
  // itself. But once a tool group settles and the model is generating its
  // next step, nothing on screen moves — resurface the thinking indicator.
  const showTailThinking =
    message.streaming &&
    lastSegment?.type === 'toolGroup' &&
    !lastSegment.calls.some((call) => call.status === 'running')

  // First light: 'waiting' until this mount sees the thinking indicator,
  // 'armed' until the first words replace it, 'active' for the ~1.2s arrival,
  // then 'done' forever. A bubble that mounts with content already present
  // (history, re-opened chats) never leaves 'waiting'.
  const [lightPhase, setLightPhase] = useState<'waiting' | 'armed' | 'active' | 'done'>(
    firstLight ? 'waiting' : 'done'
  )
  const hasSegments = segments.length > 0
  useEffect(() => {
    if (lightPhase === 'waiting' && showThinking) setLightPhase('armed')
    if (lightPhase === 'armed' && !showThinking && hasSegments) {
      setLightPhase('active')
      const timer = setTimeout(() => setLightPhase('done'), 1300)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [lightPhase, showThinking, hasSegments])
  const showFooter =
    isUser || (message.stats && !message.streaming) || showCopy || showSkillDraft || showCheckpoint

  return (
    <div className={`${styles.row} ${isUser ? styles.user : styles.assistant}`}>
      {!isUser && (
        <div className={styles.meta}>
          <AnodexLogo variant="icon" size={16} className={styles.metaLogo} />
          <span className={styles.author}>Anodex</span>
          <span className={styles.time}>{formatClock(message.createdAt)}</span>
        </div>
      )}

      <div className={styles.bubble}>
        {lightPhase === 'active' && (
          <>
            <span className={styles.firstLightFlare} aria-hidden="true">
              <Icon name="sparkle" size={15} />
            </span>
            <span className={styles.firstLightBand} aria-hidden="true" />
          </>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <MessageAttachments attachments={message.attachments} messageId={message.id} />
        )}
        {!isUser && message.memoryUsed && message.memoryUsed.length > 0 && (
          <div className={styles.memoryUsed}>
            <MemoryUsedCard entries={message.memoryUsed} />
          </div>
        )}
        {!isUser && message.transcriptRecallUsed && message.transcriptRecallUsed.length > 0 && (
          <div className={styles.memoryUsed}>
            <TranscriptRecallCard results={message.transcriptRecallUsed} />
          </div>
        )}
        {showThinking ? (
          <ThinkingIndicator />
        ) : (
          <div className={styles.segments}>
            {timeline.map((block, index) => {
              if (block.type === 'text') {
                return <MessageContent key={`text-${index}`} content={block.text} />
              }
              return (
                <TurnRecap
                  key={`work-${index}`}
                  segments={block.segments}
                  streaming={Boolean(message.streaming) && index === timeline.length - 1}
                  startedAt={message.createdAt}
                  finalDurationMs={message.stats?.durationMs}
                />
              )
            })}
          </div>
        )}
        {showTailThinking && (
          <div className={styles.tailThinking}>
            <ThinkingIndicator />
          </div>
        )}
        {message.streaming && lastSegment?.type === 'text' && <span className={styles.caret} />}

        {message.error &&
          (message.errorKind === 'bounded' ? (
            <div className={styles.notice}>
              <Icon name="info" size={14} />
              <span>{message.error}</span>
            </div>
          ) : (
            <div className={styles.error}>
              <Icon name="alert" size={14} />
              <span>{message.error}</span>
            </div>
          ))}
      </div>

      {showFooter ? (
        <div className={styles.footer}>
          {isUser && <span className={styles.footerTime}>{formatClock(message.createdAt)}</span>}
          {isUser && (
            <button
              type="button"
              className={styles.copyButton}
              onClick={() => setEditOpen(true)}
              disabled={conversationStreaming}
              aria-label="Edit message"
              title={
                conversationStreaming
                  ? 'Stop the current reply before editing'
                  : 'Edit and regenerate from this message'
              }
            >
              <Icon name="pencil" size={12} />
              Edit
            </button>
          )}
          {showCopy && (
            <button
              type="button"
              className={styles.copyButton}
              onClick={() => void handleCopy()}
              aria-label="Copy message"
            >
              <Icon name={copied ? 'check' : 'copy'} size={12} />
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
          {showSkillDraft && (
            <button
              type="button"
              className={styles.copyButton}
              onClick={handleDraftSkill}
              aria-label="Open skill draft"
              title="Open a reviewable markdown skill draft in the project skill library"
            >
              <Icon name={draftOpened ? 'check' : 'sparkle'} size={12} />
              {draftOpened ? 'Draft opened' : 'Draft skill'}
            </button>
          )}
          {showCheckpoint && (
            <button
              type="button"
              className={styles.copyButton}
              onClick={() => setCheckpointOpen(true)}
              aria-label="Review checkpoint"
              title={checkpointTitle(message)}
            >
              <Icon name={message.checkpoint?.restoredAt ? 'check' : 'restore'} size={12} />
              {checkpointButtonLabel(message)}
            </button>
          )}
          {!isUser && message.stats && !message.streaming && (
            <span className={styles.stats}>
              {message.stats.tokens} tokens · {message.stats.tokensPerSecond} tok/s
            </span>
          )}
        </div>
      ) : null}
      {checkpointOpen && activeConversationId && (
        <CheckpointDialog
          conversationId={activeConversationId}
          messageId={message.id}
          onClose={() => setCheckpointOpen(false)}
        />
      )}
      {editOpen && (
        <EditMessageDialog
          messageId={message.id}
          content={message.content}
          hasAttachments={Boolean(message.attachments?.length)}
          onClose={() => setEditOpen(false)}
        />
      )}
    </div>
  )
}

function checkpointTitle(message: ChatMessage): string {
  const files = message.checkpoint?.changedFiles ?? []
  if (message.checkpoint?.restoredAt) return 'This checkpoint has already been restored'
  return `Review changes from this turn:\n${files.join('\n')}`
}

function checkpointButtonLabel(message: ChatMessage): string {
  const checkpoint = message.checkpoint
  if (!checkpoint) return 'Checkpoint'
  if (checkpoint.restoredAt) return 'Restored'
  const remaining = checkpoint.changedFiles.length - (checkpoint.restoredFiles?.length ?? 0)
  return `Review ${remaining}`
}
