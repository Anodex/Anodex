import { useId, useMemo } from 'react'
import { ANTHROPIC_MODELS } from '@shared/anthropicModels'
import { OPENAI_MODELS } from '@shared/openaiModels'
import { estimateProjectedContextUsage } from '@shared/contextProjection'
import { providerMaxResponseTokens } from '@shared/maxResponseTokens'
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
  const detailsId = useId()
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === s.activeId))
  const engineContextSize = useModelStore((s) => s.engine.contextSize)
  const providerActive = useSettingsStore((s) => s.settings?.provider.active)
  const anthropicModel = useSettingsStore((s) => s.settings?.provider.anthropic.model)
  const openaiModel = useSettingsStore((s) => s.settings?.provider.openai.model)
  const systemPrompt = useSettingsStore((s) => s.settings?.assistantStyle.globalStyle)
  const providers = useSettingsStore((s) => s.settings?.provider)

  /**
   * The reply ceiling the active provider is configured with, if any. Off is
   * the common case — and the default on local models — so everything this
   * drives is conditional rather than showing a "no limit" state that would
   * add noise to every turn.
   */
  const responseCap = useMemo(
    () => (providers ? providerMaxResponseTokens(providers, providers.active) : undefined),
    [providers]
  )

  // `engine.contextSize` only reflects the local llama engine — cloud
  // providers never touch it, so switching to Anthropic/OpenAI left the
  // meter pinned to whatever the local model's window last was (or hidden,
  // if no local model had ever been loaded this session). Use each
  // provider's own known context window instead, mirroring what
  // `contextAssembler.ts`'s `boundHistoryForCloudProvider` actually sends.
  const contextSize = useMemo(() => {
    if (providerActive === 'anthropic') {
      return ANTHROPIC_MODELS.find((m) => m.id === anthropicModel)?.contextWindowTokens
    }
    if (providerActive === 'openai') {
      return OPENAI_MODELS.find((m) => m.id === openaiModel)?.contextWindowTokens
    }
    return engineContextSize
  }, [providerActive, anthropicModel, openaiModel, engineContextSize])

  const fixedContext = useMemo(
    () =>
      providerActive === 'local' && conversation
        ? [...conversation.messages]
            .reverse()
            .find((message) => message.role === 'assistant' && message.contextBudget)?.contextBudget
        : undefined,
    [conversation, providerActive]
  )

  const info = useMemo(() => {
    if (!contextSize || !conversation || conversation.messages.length === 0) return null

    return estimateProjectedContextUsage({
      conversation,
      contextSize,
      systemPrompt,
      fixedContext
    })
  }, [conversation, contextSize, systemPrompt, fixedContext])

  if (!info) return null

  const level = info.pct >= 90 ? 'high' : info.pct >= 70 ? 'mid' : 'low'
  const unusedTokens = Math.max(0, info.contextSize - info.usedTokens)
  const summary = [
    `projected ${info.usedTokens.toLocaleString()} / ${info.contextSize.toLocaleString()} tokens`,
    `${info.systemTokens.toLocaleString()} system`,
    `${info.toolSchemaTokens.toLocaleString()} tool schemas`,
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
  if (responseCap !== undefined) {
    summary.push(`replies capped at ${responseCap.toLocaleString()} tokens`)
  }

  // Stacked breakdown of the same projection the tooltip describes: system
  // prompt, tool definitions, recent history, and the response reservation, as slices of the
  // context window. Their widths sum to `pct` by construction (see
  // `estimateProjectedContextUsage`).
  const segments = [
    { kind: 'segSystem', tokens: info.systemTokens },
    { kind: 'segTools', tokens: info.toolSchemaTokens },
    { kind: 'segHistory', tokens: info.historyTokens },
    { kind: 'segReserved', tokens: info.reservedTokens }
  ].filter((segment) => segment.tokens > 0)

  return (
    <div
      className={[styles.meter, styles[level], className].filter(Boolean).join(' ')}
      tabIndex={0}
      aria-describedby={detailsId}
      aria-label={`${summary.join(', ')}, ${info.pct}% of context window`}
    >
      <Icon name="activity" size={12} className={styles.icon} />
      <div className={styles.track}>
        {segments.map((segment) => (
          <div
            key={segment.kind}
            className={`${styles.seg} ${styles[segment.kind]}`}
            style={{ width: `${(segment.tokens / info.contextSize) * 100}%` }}
          />
        ))}
        {/* Anchored to the right edge rather than stacked with the segments
            above: the segments describe input already spent, while this is
            room fenced off ahead of it for the reply. Only rendered when the
            user has actually set a ceiling — the usual case has none, and the
            reply may then use whatever the window has left. */}
        {responseCap !== undefined && (
          <div
            className={styles.cap}
            style={{ width: `${Math.min(100, (responseCap / info.contextSize) * 100)}%` }}
          />
        )}
      </div>
      <span className={styles.label}>
        ~{formatTokenCount(info.usedTokens)}
        <span className={styles.labelMuted}> / {formatTokenCount(info.contextSize)}</span>
        {responseCap !== undefined && (
          <span className={styles.labelMuted}> · max {formatTokenCount(responseCap)}</span>
        )}
      </span>

      <div id={detailsId} className={styles.popover} role="tooltip">
        <div className={styles.popoverHeader}>
          <span>Context window</span>
          <strong>{info.pct}% full</strong>
        </div>

        <div className={styles.popoverRow}>
          <span>Used tokens</span>
          <strong>{info.usedTokens.toLocaleString()}</strong>
        </div>
        <div className={styles.popoverRow}>
          <span>
            <i className={`${styles.swatch} ${styles.swatchTools}`} />
            Tool definitions
          </span>
          <strong>{info.toolSchemaTokens.toLocaleString()}</strong>
        </div>
        <div className={styles.popoverRow}>
          <span>
            <i className={`${styles.swatch} ${styles.swatchSystem}`} />
            System prompt
          </span>
          <strong>{info.systemTokens.toLocaleString()}</strong>
        </div>
        <div className={styles.popoverRow}>
          <span>
            <i className={`${styles.swatch} ${styles.swatchHistory}`} />
            Recent history
          </span>
          <strong>{info.historyTokens.toLocaleString()}</strong>
        </div>
        <div className={styles.popoverRow}>
          <span>
            <i className={`${styles.swatch} ${styles.swatchReserved}`} />
            Reserved reply room
          </span>
          <strong>{info.reservedTokens.toLocaleString()}</strong>
        </div>
        {responseCap !== undefined && (
          <div className={styles.popoverRow}>
            <span>
              <i className={`${styles.swatch} ${styles.swatchCap}`} />
              Reply cap
            </span>
            <strong>{responseCap.toLocaleString()}</strong>
          </div>
        )}
        <div className={styles.popoverRow}>
          <span>Unused window</span>
          <strong>{unusedTokens.toLocaleString()}</strong>
        </div>

        {(info.snapshotApplied || info.omittedTurns > 0) && (
          <div className={styles.popoverNote}>
            {info.snapshotApplied && (
              <span>
                {info.snapshotTokens.toLocaleString()} snapshot tokens from {info.snapshotTurns}{' '}
                compacted turn{info.snapshotTurns === 1 ? '' : 's'}.
              </span>
            )}
            {info.omittedTurns > 0 && (
              <span>
                {info.omittedTurns} older turn{info.omittedTurns === 1 ? '' : 's'} would compact.
              </span>
            )}
          </div>
        )}
        {info.toolRoutingApplied && (
          <div className={styles.popoverNote}>
            <span>
              {info.activeToolCount} compact tool schema
              {info.activeToolCount === 1 ? '' : 's'} loaded; {info.deferredToolCount} more
              available on demand.
            </span>
          </div>
        )}
        {fixedContext?.effectiveMaxOutputTokens !== undefined &&
          fixedContext.requestedMaxOutputTokens !== undefined &&
          fixedContext.effectiveMaxOutputTokens < fixedContext.requestedMaxOutputTokens && (
            <div className={styles.popoverNote}>
              <span>
                Local output capped at {fixedContext.effectiveMaxOutputTokens.toLocaleString()} of{' '}
                {fixedContext.requestedMaxOutputTokens.toLocaleString()} requested tokens to protect
                this context window.
              </span>
            </div>
          )}
      </div>
    </div>
  )
}
