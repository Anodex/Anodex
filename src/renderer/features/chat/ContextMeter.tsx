import { useMemo } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { Icon } from '../../components/Icon'
import styles from './ContextMeter.module.css'

/** Fallback estimate for conversations the engine hasn't tokenized yet this session. */
const CHARS_PER_TOKEN = 4

function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`
}

/** Shows how much of the model's context window the active conversation is using. */
export function ContextMeter(): JSX.Element | null {
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === s.activeId))
  const engine = useModelStore((s) => s.engine)

  const info = useMemo(() => {
    const contextSize = engine.contextSize
    if (!contextSize || !conversation || conversation.messages.length === 0) return null

    // Prefer the engine's real token count for the active session (from the
    // llama.cpp context sequence, which includes the system prompt, tool
    // schemas, and replayed history — not just this conversation's message
    // text). It's only meaningful once tagged to this exact conversation;
    // otherwise (e.g. just switched to an old conversation, nothing
    // generated yet this run) fall back to a rough length-based estimate.
    const live =
      engine.contextTokensConversationId === conversation.id ? engine.contextTokensUsed : undefined
    const used =
      live ??
      Math.round(
        conversation.messages.reduce((sum, m) => sum + m.content.length, 0) / CHARS_PER_TOKEN
      )

    return {
      used,
      contextSize,
      pct: Math.min(100, Math.round((used / contextSize) * 100)),
      approximate: live === undefined
    }
  }, [conversation, engine])

  if (!info) return null

  const level = info.pct >= 90 ? 'high' : info.pct >= 70 ? 'mid' : 'low'
  const approx = info.approximate ? '~' : ''

  return (
    <div
      className={`${styles.meter} ${styles[level]}`}
      title={`${approx}${info.used.toLocaleString()} / ${info.contextSize.toLocaleString()} tokens (${info.pct}% of context window)`}
    >
      <Icon name="activity" size={12} className={styles.icon} />
      <div className={styles.track}>
        <div className={styles.fill} style={{ width: `${info.pct}%` }} />
      </div>
      <span className={styles.label}>
        {approx}
        {formatTokenCount(info.used)}
        <span className={styles.labelMuted}> / {formatTokenCount(info.contextSize)}</span>
      </span>
    </div>
  )
}
