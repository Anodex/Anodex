import { useState } from 'react'
import type { ChatMessage } from '@shared/chat.types'
import { AnodexLogo } from '../../components/AnodexLogo'
import { FileTypeIcon } from '../../components/FileTypeIcon'
import { Icon } from '../../components/Icon'
import { formatBytes, formatClock } from '../../lib/format'
import { savePendingSkillEditorDraft } from '../../lib/skillEditorDraftHandoff'
import { buildSkillDraft } from '../../lib/skillDraft'
import { useUiStore } from '../../stores/uiStore'
import { MemoryUsedCard } from './MemoryUsedCard'
import { TranscriptRecallCard } from './TranscriptRecallCard'
import { MessageContent } from './MessageContent'
import { ThinkingIndicator } from './ThinkingIndicator'
import { ToolCallGroup } from './ToolCallGroup'
import { buildRenderSegments, messageBlocks } from './taskPhase'
import styles from './MessageBubble.module.css'

/** A single chat turn: avatar, author/time meta, content, and optional stats. */
export function MessageBubble({
  message,
  previousUserContent
}: {
  message: ChatMessage
  previousUserContent?: string
}): JSX.Element {
  const isUser = message.role === 'user'
  const openSettings = useUiStore((s) => s.openSettings)
  const notify = useUiStore((s) => s.notify)
  const [copied, setCopied] = useState(false)
  const [draftOpened, setDraftOpened] = useState(false)
  const showCopy = !message.streaming && message.content.length > 0
  const showSkillDraft =
    !isUser &&
    !message.streaming &&
    message.content.length > 0 &&
    (message.toolCalls?.some((call) => call.status === 'success') ?? false)

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

  return (
    <div className={`${styles.row} ${isUser ? styles.user : styles.assistant}`}>
      <div className={styles.avatar}>
        {isUser ? <span className={styles.userAvatar}>You</span> : <AnodexLogo size={28} />}
      </div>

      <div className={styles.column}>
        <div className={styles.meta}>
          <span className={styles.author}>{isUser ? 'You' : 'Anodex'}</span>
          <span className={styles.time}>{formatClock(message.createdAt)}</span>
        </div>

        <div className={styles.bubble}>
          {message.attachments && message.attachments.length > 0 && (
            <div className={styles.attachments}>
              {message.attachments.map((attachment) => (
                <span key={attachment.path} className={styles.attachment} title={attachment.path}>
                  <FileTypeIcon fileName={attachment.name} size={13} />
                  <span className={styles.attachmentName}>{attachment.name}</span>
                  <span className={styles.attachmentSize}>{formatBytes(attachment.sizeBytes)}</span>
                </span>
              ))}
            </div>
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
              {segments.map((segment, index) =>
                segment.type === 'text' ? (
                  <MessageContent key={`text-${index}`} content={segment.text} />
                ) : (
                  <ToolCallGroup
                    key={`tools-${index}`}
                    phase={segment.phase}
                    calls={segment.calls}
                  />
                )
              )}
            </div>
          )}
          {message.streaming && lastSegment?.type === 'text' && <span className={styles.caret} />}

          {message.error && (
            <div className={styles.error}>
              <Icon name="alert" size={14} />
              <span>{message.error}</span>
            </div>
          )}
        </div>

        {(message.stats && !message.streaming) || showCopy || showSkillDraft ? (
          <div className={styles.footer}>
            {message.stats && !message.streaming && (
              <span className={styles.stats}>
                {message.stats.tokens} tokens · {message.stats.tokensPerSecond} tok/s
              </span>
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
          </div>
        ) : null}
      </div>
    </div>
  )
}
