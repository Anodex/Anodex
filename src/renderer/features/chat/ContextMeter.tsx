import { useMemo } from 'react'
import { estimateProjectedContextUsage } from '@shared/contextProjection'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { Icon } from '../../components/Icon'
import styles from './ContextMeter.module.css'

function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`
}

/** Shows the estimated model-facing context projection for the active conversation. */
export function ContextMeter({ className }: { className?: string } = {}): JSX.Element | null {
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === s.activeId))
  const engine = useModelStore((s) => s.engine)
  const systemPrompt = useSettingsStore((s) => s.settings?.ui.systemPrompt)

  const info = useMemo(() => {
    const contextSize = engine.contextSize
    if (!contextSize || !conversation || conversation.messages.length === 0) return null

    return estimateProjectedContextUsage({
      conversation,
      contextSize,
      systemPrompt
    })
  }, [conversation, engine.contextSize, systemPrompt])

  if (!info) return null

  const level = info.pct >= 90 ? 'high' : info.pct >= 70 ? 'mid' : 'low'
  const summary = [
    `projected ${info.usedTokens.toLocaleString()} / ${info.contextSize.toLocaleString()} tokens`,
    `${info.systemTokens.toLocaleString()} system`,
    `${info.historyTokens.toLocaleString()} recent history`,
    `${info.reservedTokens.toLocaleString()} reserved`
  ]
  if (info.snapshotApplied) {
    summary.push(
      `${info.snapshotTokens.toLocaleString()} snapshot tokens from ${
        info.snapshotTurns
      } compacted turn${info.snapshotTurns === 1 ? '' : 's'}`
    )
  }
  if (info.omittedTurns > 0) {
    summary.push(
      `${info.omittedTurns} older turn${info.omittedTurns === 1 ? '' : 's'} would compact`
    )
  }

  return (
    <div
      className={[styles.meter, styles[level], className].filter(Boolean).join(' ')}
      title={`${summary.join(' | ')} (${info.pct}% of context window)`}
    >
      <Icon name="activity" size={12} className={styles.icon} />
      <div className={styles.track}>
        <div className={styles.fill} style={{ width: `${info.pct}%` }} />
      </div>
      <span className={styles.label}>
        ~{formatTokenCount(info.usedTokens)}
        <span className={styles.labelMuted}> / {formatTokenCount(info.contextSize)}</span>
      </span>
    </div>
  )
}
