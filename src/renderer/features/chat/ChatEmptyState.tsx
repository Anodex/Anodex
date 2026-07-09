import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useUiStore } from '../../stores/uiStore'
import { AnodexLogo } from '../../components/AnodexLogo'
import { Icon } from '../../components/Icon'
import { ChatConstellation } from './ChatConstellation'
import styles from './ChatEmptyState.module.css'

const SUGGESTIONS = [
  'Explain this error and how to fix it',
  'Write a TypeScript function to debounce calls',
  'Refactor this snippet to be more readable',
  'Summarize how async/await works'
]

/** Shown when the active conversation has no messages yet. */
export function ChatEmptyState(): JSX.Element {
  const ready = useModelStore((s) => s.engine.status === 'ready')
  const sendMessage = useChatStore((s) => s.sendMessage)
  const openSettings = useUiStore((s) => s.openSettings)

  return (
    <div className={styles.empty}>
      <ChatConstellation />
      <div className={styles.hero}>
        <AnodexLogo variant="icon" size={72} className={styles.heroIcon} />
        <h2 className={styles.heading}>How can I help you build?</h2>
        <p className={styles.subtitle}>
          Anodex is a local-first assistant for coding help and general chat.
        </p>
      </div>

      {ready ? (
        <div className={styles.suggestions}>
          <div className={styles.suggestionsLabel}>Try a quick prompt</div>
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              className={styles.suggestion}
              onClick={() => void sendMessage(suggestion)}
            >
              <Icon name="sparkle" size={15} />
              <span>{suggestion}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className={styles.callout}>
          <span className={styles.calloutIcon}>
            <Icon name="cpu" size={20} />
          </span>
          <div className={styles.calloutBody}>
            <div className={styles.calloutTitle}>No model loaded</div>
            <div className={styles.calloutText}>
              Load a local model to start chatting — it runs entirely on your machine.
            </div>
          </div>
          <button className={styles.calloutButton} onClick={() => openSettings('ai-models')}>
            Open Settings
          </button>
        </div>
      )}
    </div>
  )
}
