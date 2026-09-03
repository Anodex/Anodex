import { useEffect, useState } from 'react'
import type { ChatMessage } from '@shared/chat.types'
import { AnodexLogo } from '../../components/AnodexLogo'
import { PersonalityAvatar } from '../../components/ui/PersonalityAvatar'
import { personalityDisplayName } from '../../components/ui/personalityIdentity'
import { findChatPersonality } from '@shared/chatPersonality'
import { useSettingsStore } from '../../stores/settingsStore'
import { Icon } from '../../components/Icon'
import { formatClock } from '../../lib/format'
import { savePendingSkillEditorDraft } from '../../lib/skillEditorDraftHandoff'
import { buildSkillDraft } from '../../lib/skillDraft'
import { useChatStore, type MessageEditOptions } from '../../stores/chatStore'
import { useUiStore } from '../../stores/uiStore'
import { MemoryUsedCard } from './MemoryUsedCard'
import { TranscriptRecallCard } from './TranscriptRecallCard'
import { MessageContent } from './MessageContent'
import { MessageSources } from './MessageSources'
import { LiveActivityIndicator } from './LiveActivityIndicator'
import { TurnRecap } from './TurnRecap'
import { CheckpointDialog } from './CheckpointDialog'
import { EditMessageDialog } from './EditMessageDialog'
import { RegenerateDialog } from './RegenerateDialog'
import type { RegenerateTarget } from './messageEdit'
import { MessageAttachments } from './MessageAttachments'
import {
  buildRenderSegments,
  foldSettledTimeline,
  groupSegmentsForTimeline,
  liveActivityLabel,
  messageBlocks
} from './taskPhase'
import type { VisualComparisonPair } from './visualComparisonPair'
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
  firstLight = false,
  visualComparison,
  regenerateTarget = null
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
  /** Comparison derived from this message plus earlier visual previews. */
  visualComparison?: VisualComparisonPair | null
  /**
   * What regenerating this reply would replay and discard, or `null` when
   * there is nothing to replay. Resolved by `MessageList` from the same
   * helper the store uses, so the button and the action can't disagree.
   */
  regenerateTarget?: RegenerateTarget | null
}): JSX.Element {
  const isUser = message.role === 'user'
  const openSettings = useUiStore((s) => s.openSettings)
  const notify = useUiStore((s) => s.notify)
  const activeConversationId = useChatStore((s) => s.activeId)
  const [copied, setCopied] = useState(false)
  const [draftOpened, setDraftOpened] = useState(false)
  const [checkpointOpen, setCheckpointOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const regenerateMessage = useChatStore((s) => s.regenerateMessage)
  /** Open only for the two questions regenerating can raise — see `RegenerateDialog`. */
  const [regenerateAsking, setRegenerateAsking] = useState(false)
  const [regenerateConflicts, setRegenerateConflicts] = useState<string[] | null>(null)
  const [regenerateBusy, setRegenerateBusy] = useState(false)
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
  // Deliberately not gated on having produced any content: a reply that
  // stalled out empty is exactly the one worth asking again for.
  const showRegenerate = !isUser && !message.streaming && Boolean(regenerateTarget)

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* Clipboard unavailable — silently ignore. */
    }
  }

  const runRegenerate = async (options?: MessageEditOptions): Promise<void> => {
    if (regenerateBusy) return
    setRegenerateBusy(true)
    try {
      const result = await regenerateMessage(message.id, options)
      // A conflict is the rollback asking a question, not a failure — keep the
      // dialog up (opening it if the one-click path skipped it) so the user can
      // answer. Anything else is done: on success this bubble is gone.
      if (result.status === 'conflict') {
        setRegenerateConflicts(result.conflicts)
        setRegenerateAsking(true)
      } else {
        setRegenerateAsking(false)
        setRegenerateConflicts(null)
      }
    } finally {
      setRegenerateBusy(false)
    }
  }

  const handleRegenerate = (): void => {
    // Nothing to lose and nothing to ask — replace the reply on the click.
    if ((regenerateTarget?.laterTurnCount ?? 0) === 0) {
      void runRegenerate()
      return
    }
    setRegenerateAsking(true)
  }

  const closeRegenerate = (): void => {
    setRegenerateAsking(false)
    setRegenerateConflicts(null)
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
  const showInitialActivity = message.streaming && segments.length === 0
  const lastSegment = segments[segments.length - 1]
  // Folded only once the reply has settled: while it streams, watching it
  // work is the point. See `foldSettledTimeline`.
  const grouped = groupSegmentsForTimeline(segments)
  const timeline = message.streaming ? grouped : foldSettledTimeline(grouped)

  /**
   * A user message that is nothing but attachments has no bubble to draw.
   * Sending a picture on its own used to render an empty bordered box beneath
   * it. Assistant turns always keep theirs -- they carry activity, tool cards
   * and errors even before any text arrives.
   */
  const showBubble = !isUser || message.content.trim().length > 0 || Boolean(message.error)

  // The active personality, when one is selected. Free-text guidance is not a
  // character and keeps the Anodex byline.
  const persona = useSettingsStore((state) => {
    const style = state.settings?.assistantStyle
    return findChatPersonality(style?.personalities, style?.activePersonalityId)
  })
  const personaName = persona ? personalityDisplayName(persona) : 'Anodex'
  const firstWorkBlockIndex = timeline.findIndex((block) => block.type === 'work')
  // The tail of a streaming message always carries an unobtrusive live status.
  // Tool names come from actual activity events; other labels describe only
  // the observable generation state, not unexposed model reasoning.
  const tailActivityLabel =
    message.streaming && lastSegment
      ? lastSegment.type === 'text'
        ? 'Writing response'
        : liveActivityLabel(message.toolCalls ?? [], false)
      : null

  // First light: 'waiting' until this mount sees the thinking indicator,
  // 'armed' until the first words replace it, 'active' for the ~1.2s arrival,
  // then 'done' forever. A bubble that mounts with content already present
  // (history, re-opened chats) never leaves 'waiting'.
  const [lightPhase, setLightPhase] = useState<'waiting' | 'armed' | 'active' | 'done'>(
    firstLight ? 'waiting' : 'done'
  )
  const hasSegments = segments.length > 0
  useEffect(() => {
    if (lightPhase === 'waiting' && showInitialActivity) setLightPhase('armed')
    if (lightPhase === 'armed' && !showInitialActivity && hasSegments) {
      setLightPhase('active')
      const timer = setTimeout(() => setLightPhase('done'), 1300)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [lightPhase, showInitialActivity, hasSegments])
  const showFooter =
    isUser || (message.stats && !message.streaming) || showCopy || showSkillDraft || showCheckpoint

  return (
    <div className={`${styles.row} ${isUser ? styles.user : styles.assistant}`}>
      {!isUser && (
        <div className={styles.meta}>
          {/* A named personality answers under its own name and face. Until
              this, a personality changed how the assistant talked with no
              evidence anywhere that anything had happened. Anodex stays the
              byline whenever no character is selected, and the tooltip keeps
              saying Anodex either way so a persona is never mistaken for a
              different product. */}
          {persona ? (
            <PersonalityAvatar personality={persona} size={16} className={styles.metaLogo} />
          ) : (
            <AnodexLogo variant="icon" size={16} className={styles.metaLogo} />
          )}
          <span className={styles.author} title={persona ? `${personaName} — Anodex` : 'Anodex'}>
            {persona ? personaName : 'Anodex'}
          </span>
          <span className={styles.time}>{formatClock(message.createdAt)}</span>
        </div>
      )}

      {/* Outside the bubble on purpose. Nested inside it, an attached picture
          inherited the bubble's fill, border and 72% cap and read as a file
          record rather than an image someone shared. `.user` is already
          `align-items: flex-end`, so it right-aligns on its own. */}
      {message.attachments && message.attachments.length > 0 && (
        <MessageAttachments attachments={message.attachments} messageId={message.id} />
      )}

      {/* An attachment sent with no text used to render an empty bordered box
          under the picture. Nothing to say means no bubble. */}
      {showBubble && (
        <div className={styles.bubble}>
          {lightPhase === 'active' && (
            <>
              <span className={styles.firstLightFlare} aria-hidden="true">
                <Icon name="sparkle" size={15} />
              </span>
              <span className={styles.firstLightBand} aria-hidden="true" />
            </>
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
          {showInitialActivity ? (
            <LiveActivityIndicator label={liveActivityLabel(message.toolCalls ?? [], false)} />
          ) : (
            <div className={styles.segments}>
              {timeline.map((block, index) => {
                if (block.type === 'text') {
                  return (
                    <MessageContent
                      key={`text-${index}`}
                      content={block.text}
                      sources={message.webSources}
                    />
                  )
                }
                const blockCalls = block.segments.flatMap((segment) =>
                  segment.type === 'toolGroup' ? segment.calls : []
                )
                const blockComparison =
                  visualComparison === undefined
                    ? undefined
                    : visualComparison &&
                        blockCalls.some((call) => call.id === visualComparison.afterCallId)
                      ? visualComparison
                      : null
                return (
                  <TurnRecap
                    key={`work-${index}`}
                    segments={block.segments}
                    streaming={Boolean(message.streaming) && index === timeline.length - 1}
                    startedAt={message.createdAt}
                    finalDurationMs={message.stats?.durationMs}
                    showTotalDuration={index === firstWorkBlockIndex}
                    comparison={blockComparison}
                  />
                )
              })}
            </div>
          )}
          {tailActivityLabel && (
            <div className={styles.tailActivity}>
              <LiveActivityIndicator label={tailActivityLabel} />
            </div>
          )}

          {!isUser && (
            <MessageSources
              sources={message.webSources}
              attempted={Boolean(message.webSearchAttempted)}
              streaming={Boolean(message.streaming)}
            />
          )}

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
      )}

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
          {showRegenerate && (
            <button
              type="button"
              className={styles.copyButton}
              onClick={handleRegenerate}
              disabled={conversationStreaming || regenerateBusy}
              aria-label="Regenerate reply"
              title={
                conversationStreaming
                  ? 'Stop the current reply before regenerating'
                  : 'Ask the same question again for a different answer'
              }
            >
              <Icon name="rotate-ccw" size={12} />
              Regenerate
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
      {regenerateAsking && (
        <RegenerateDialog
          laterTurnCount={regenerateTarget?.laterTurnCount ?? 0}
          conflicts={regenerateConflicts}
          busy={regenerateBusy}
          onRun={(options) => void runRegenerate(options)}
          onClose={closeRegenerate}
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
