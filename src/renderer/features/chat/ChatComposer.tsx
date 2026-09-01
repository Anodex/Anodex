import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { messageToHistoryTurn } from '@shared/chatSanitizer'
import { planManualContextCompaction } from '@shared/contextProjection'
import { useChatStore, type PendingMessage } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useProjectStore } from '../../stores/projectStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { notifyError } from '../../stores/uiStore'
import { isChatReady } from '../../lib/chatReadiness'
import { agentRunProviderVendor } from '@shared/agentRunProviders'
import { COMPOSER_INPUT_ATTR } from '../../hooks/useGlobalKeyboardShortcuts'
import { Icon } from '../../components/Icon'
import { MAX_ATTACHMENTS } from '../../lib/attachments'
import { ContextMeter } from './ContextMeter'
import { ToolConfirmCard } from './ToolConfirmCard'
import { suggestionFromPlan } from '../../lib/replaySuggestions'
import { expandSlashCommand, goalFromSlashCommand } from '../../lib/slashCommands'
import { ComposerAttachments } from './composer/ComposerAttachments'
import { ComposerPendingQueue } from './composer/ComposerPendingQueue'
import { ComposerPermissionMenu } from './composer/ComposerPermissionMenu'
import { ComposerSkillHint } from './composer/ComposerSkillHint'
import { ComposerSlashPicker } from './composer/ComposerSlashPicker'
import { ComposerGoalBar } from './composer/ComposerGoalBar'
import { useComposerAttachments } from './composer/useComposerAttachments'
import { useComposerSlashPicker } from './composer/useComposerSlashPicker'
import styles from './ChatComposer.module.css'

const MAX_TEXTAREA_HEIGHT = 200
// Stable reference for the no-queue case. A new empty array on each selector
// pass would look like a changed external-store snapshot to React.
const EMPTY_QUEUE: PendingMessage[] = []
const EMPTY_SKILL_NAMES: string[] = []

/**
 * The composer coordinates chat state and lays out focused composer modules.
 * See `composer/` for attachments, pending messages, permission controls, and
 * slash-command/skill discovery.
 */
export function ChatComposer(): JSX.Element {
  const [text, setText] = useState('')
  const [compacting, setCompacting] = useState(false)
  const [dismissedReplaySuggestionKey, setDismissedReplaySuggestionKey] = useState<string | null>(
    null
  )
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const activeConversation = useChatStore((state) =>
    state.conversations.find((conversation) => conversation.id === state.activeId)
  )
  const sendMessage = useChatStore((state) => state.sendMessage)
  const queueMessage = useChatStore((state) => state.queueMessage)
  const removeQueuedMessage = useChatStore((state) => state.removeQueuedMessage)
  const pendingQueue = useChatStore((state) =>
    state.activeId ? (state.pendingMessages[state.activeId] ?? EMPTY_QUEUE) : EMPTY_QUEUE
  )
  const stopGeneration = useChatStore((state) => state.stopGeneration)
  const pendingComposerText = useChatStore((state) => state.pendingComposerText)
  const setPendingComposerText = useChatStore((state) => state.setPendingComposerText)
  const clearReplaySuggestion = useChatStore((state) => state.clearReplaySuggestion)
  const setConversationGoal = useChatStore((state) => state.setConversationGoal)
  const clearConversationGoal = useChatStore((state) => state.clearConversationGoal)
  const compactConversation = useChatStore((state) => state.compactConversation)
  const engine = useModelStore((state) => state.engine)
  const settings = useSettingsStore((state) => state.settings)
  const updateSettings = useSettingsStore((state) => state.update)
  const projects = useProjectStore((state) => state.projects)

  const activeProject = projects.find((project) => project.id === activeConversation?.projectId)
  const pinnedSkillNames = activeProject?.pinnedSkillNames ?? EMPTY_SKILL_NAMES
  const permissionMode = settings?.general.permissionMode ?? 'ask'
  const ready = isChatReady(settings, engine.status)
  const localReady = engine.status === 'ready'
  const localVision = settings?.provider.active === 'local' && Boolean(engine.vision)
  const cloudVision =
    settings?.provider.active === 'anthropic' || settings?.provider.active === 'openai'
  const visionAvailable = localVision || cloudVision
  const generating = activeConversation?.messages.some((message) => message.streaming) ?? false

  const autoGrow = (): void => {
    const input = textareaRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }

  const attachments = useComposerAttachments({ ready, visionAvailable })
  const slashPicker = useComposerSlashPicker({
    projectId: activeConversation?.projectId,
    text,
    setText,
    ready,
    pinnedSkillNames,
    textareaRef,
    autoGrow
  })

  const hasContent = text.trim().length > 0 || attachments.attachments.length > 0
  const canSend = ready && !generating && hasContent
  const canQueue = ready && generating && hasContent
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
  const planReplaySuggestion = useMemo(
    () => suggestionFromPlan(activeConversation?.plan),
    [activeConversation?.plan]
  )
  const generatedReplaySuggestion = activeConversation?.replaySuggestion
  const replaySuggestion = planReplaySuggestion ?? generatedReplaySuggestion?.text ?? null
  const replaySuggestionKey = planReplaySuggestion
    ? `plan:${activeConversation?.plan?.updatedAt ?? 0}:${planReplaySuggestion}`
    : generatedReplaySuggestion
      ? `model:${generatedReplaySuggestion.messageId}:${generatedReplaySuggestion.createdAt}`
      : null
  const showReplaySuggestion = Boolean(
    ready &&
    !generating &&
    text.length === 0 &&
    attachments.attachments.length === 0 &&
    replaySuggestion &&
    replaySuggestionKey !== dismissedReplaySuggestionKey
  )

  useEffect(() => {
    if (pendingComposerText === null) return
    setText(pendingComposerText)
    setPendingComposerText(null)
    textareaRef.current?.focus()
  }, [pendingComposerText, setPendingComposerText])

  useEffect(() => {
    setDismissedReplaySuggestionKey(null)
  }, [activeConversation?.id, replaySuggestionKey])

  const resetHeight = (): void => {
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const focusComposer = (): void => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      autoGrow()
    })
  }

  const acceptReplaySuggestion = (): void => {
    if (!replaySuggestion) return
    setText(replaySuggestion)
    focusComposer()
  }

  const submit = (): void => {
    if (
      attachments.attachments.some((attachment) => attachment.kind === 'image') &&
      !visionAvailable
    ) {
      notifyError(
        'Vision model required',
        'Load a local model with its matching mmproj projector, or select an image-capable cloud model.'
      )
      return
    }
    const goal = goalFromSlashCommand(text)
    if (goal) setConversationGoal(goal)

    if (generating) {
      if (!canQueue) return
      const value = expandSlashCommand(text)?.expandedText ?? text
      const pendingAttachments = attachments.attachments
      setText('')
      attachments.clearAttachments()
      resetHeight()
      queueMessage(value, pendingAttachments)
      return
    }
    if (!canSend) return
    const value = expandSlashCommand(text)?.expandedText ?? text
    const pendingAttachments = attachments.attachments
    setText('')
    attachments.clearAttachments()
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

  const stopGoalAndGeneration = (): void => {
    clearConversationGoal()
    void stopGeneration()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashPicker.handleKeyDown(event)) return

    if (event.key === 'Tab' && showReplaySuggestion) {
      event.preventDefault()
      acceptReplaySuggestion()
      return
    }
    if (event.key === 'Escape' && showReplaySuggestion && replaySuggestionKey) {
      event.preventDefault()
      setDismissedReplaySuggestionKey(replaySuggestionKey)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div
      className={`${styles.composer} ${attachments.dragActive ? styles.dragActive : ''}`}
      onDragEnter={attachments.handleDragEnter}
      onDragOver={attachments.handleDragOver}
      onDragLeave={attachments.handleDragLeave}
      onDrop={attachments.handleDrop}
    >
      <div className={styles.composerTop}>
        <ToolConfirmCard />
        {activeConversation && (
          <ComposerPendingQueue
            conversationId={activeConversation.id}
            messages={pendingQueue}
            onRemove={removeQueuedMessage}
          />
        )}
        <ComposerAttachments
          attachments={attachments.attachments}
          onRemove={attachments.removeAttachment}
        />
        {slashPicker.showSlashPicker && (
          <ComposerSlashPicker
            commands={slashPicker.slashCommands}
            skills={slashPicker.slashSkills}
            activeIndex={slashPicker.activeIndex}
            onSelectCommand={slashPicker.selectCommand}
            onSelectSkill={slashPicker.selectSkill}
            onDismiss={slashPicker.dismissSlashPicker}
          />
        )}
        {slashPicker.visibleSkillSuggestion && !generating && (
          <ComposerSkillHint
            skill={slashPicker.visibleSkillSuggestion}
            onUse={slashPicker.useSuggestedSkill}
            onDismiss={slashPicker.dismissSkillSuggestion}
          />
        )}
      </div>

      {activeConversation?.goal && (
        <ComposerGoalBar
          goal={activeConversation.goal}
          plan={activeConversation.plan}
          running={generating}
          onStop={() => void stopGeneration()}
          onClear={clearConversationGoal}
        />
      )}

      <div className={`${styles.inputShell} ${!ready ? styles.disabled : ''}`}>
        {showReplaySuggestion && replaySuggestion && (
          <div className={styles.replaySuggestion} aria-hidden="true">
            <span>{replaySuggestion}</span>
            <kbd>Tab</kbd>
          </div>
        )}
        <textarea
          ref={textareaRef}
          {...{ [COMPOSER_INPUT_ATTR]: '' }}
          className={styles.textarea}
          value={text}
          rows={1}
          disabled={!ready}
          spellCheck={true}
          placeholder={
            showReplaySuggestion
              ? ''
              : attachments.dragActive
                ? 'Drop to attach…'
                : ready
                  ? 'Message Anodex…'
                  : settings && settings.provider.active !== 'local'
                    ? `Add ${agentRunProviderVendor(settings.provider.active)} credentials in Settings → AI & Models to start chatting`
                    : 'Load a model from the Models tab to start chatting'
          }
          onChange={(event) => {
            if (event.target.value.length > 0 && activeConversation) {
              clearReplaySuggestion(activeConversation.id)
            }
            setText(event.target.value)
            autoGrow()
          }}
          onKeyDown={handleKeyDown}
        />

        <div className={styles.inputBottom}>
          <button
            type="button"
            className={styles.ghostAction}
            onClick={() => void attachments.handleAttachClick()}
            disabled={!ready || attachments.attachments.length >= MAX_ATTACHMENTS}
            title={visionAvailable ? 'Attach files or images' : 'Attach files'}
            aria-label={visionAvailable ? 'Attach files or images' : 'Attach files'}
          >
            <Icon name="paperclip" size={15} />
          </button>

          <ComposerPermissionMenu
            mode={permissionMode}
            onSelect={(mode) => void updateSettings({ general: { permissionMode: mode } })}
          />

          <div className={styles.meterSlot}>
            <ContextMeter className={styles.contextMeter} />
          </div>

          <button
            type="button"
            className={styles.ghostAction}
            onClick={() => void compact()}
            disabled={!canCompact}
            title="Compact chat context"
            aria-label="Compact chat context"
          >
            <Icon name={compacting ? 'refresh' : 'archive'} size={13} />
          </button>

          {generating && !hasContent ? (
            <button
              className={`${styles.action} ${styles.stop}`}
              onClick={stopGoalAndGeneration}
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
      </div>
    </div>
  )
}
