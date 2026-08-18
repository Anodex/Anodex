import { useEffect, useRef, useState } from 'react'
import type { RenderSegment } from './taskPhase'
import { Icon } from '../../components/Icon'
import { formatDuration } from '../../lib/format'
import { ThoughtsSection } from './ThoughtsSection'
import { ToolCallCard } from './ToolCallCard'
import { VisualComparison } from './VisualComparison'
import { latestVisualComparison, type VisualComparisonPair } from './visualComparisonPair'
import styles from './TurnRecap.module.css'

type WorkSegment = Extract<RenderSegment, { type: 'thinking' | 'toolGroup' }>

/**
 * Collapses a turn's thinking + tool-call activity behind one "Worked for
 * Xs" line, so the transcript reads as the reply it produced rather than the
 * scaffolding that got it there. Expanded, it's the same ThoughtsSection and
 * ToolCallCard rendering as before — nothing about that changed, only how
 * much of it you have to look at by default.
 */
export function TurnRecap({
  segments,
  streaming,
  startedAt,
  finalDurationMs,
  showTotalDuration = true,
  comparison
}: {
  segments: WorkSegment[]
  /** True while this specific run is still the live tail of a streaming message. */
  streaming: boolean
  startedAt: number
  /** Authoritative total once the whole message has finished generating. */
  finalDurationMs?: number
  /** Only one recap in a settled message should claim its message-wide duration. */
  showTotalDuration?: boolean
  /** Explicit message-level comparison, or undefined for standalone/in-turn derivation. */
  comparison?: VisualComparisonPair | null
}): JSX.Element {
  const calls = segments.flatMap((segment) => (segment.type === 'toolGroup' ? segment.calls : []))
  const resolvedComparison =
    comparison === undefined ? latestVisualComparison([], calls) : comparison
  const hasImagePreview = calls.some((call) => call.preview?.kind === 'image')
  const hasVisualResult = hasImagePreview || Boolean(resolvedComparison)
  const [expanded, setExpanded] = useState(streaming || hasVisualResult)
  const [settledMs, setSettledMs] = useState<number | null>(null)
  const [, forceTick] = useState(0)
  const wasStreaming = useRef(streaming)

  // Live elapsed ticker while this run is active.
  useEffect(() => {
    if (!streaming) return
    const interval = setInterval(() => forceTick((t) => t + 1), 250)
    return () => clearInterval(interval)
  }, [streaming])

  // The moment work finishes, snapshot the elapsed time and fold back down
  // after a beat so the final state is visible before it collapses.
  useEffect(() => {
    if (wasStreaming.current && !streaming) {
      setSettledMs(Date.now() - startedAt)
      wasStreaming.current = streaming
      if (hasVisualResult) {
        setExpanded(true)
        return undefined
      }
      const timer = setTimeout(() => setExpanded(false), 900)
      return () => clearTimeout(timer)
    }
    wasStreaming.current = streaming
    return undefined
  }, [hasVisualResult, streaming, startedAt])

  const hasRunningCall = calls.some((call) => call.status === 'running')
  const elapsedMs = streaming ? Date.now() - startedAt : (finalDurationMs ?? settledMs ?? 0)
  const label = streaming
    ? `Working for ${formatDuration(elapsedMs)}`
    : showTotalDuration
      ? `Worked for ${formatDuration(elapsedMs)}`
      : 'Work details'

  return (
    <div className={styles.turnHead}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Show'} turn activity`}
      >
        <Icon
          name="chevron-right"
          size={12}
          className={`${styles.chev} ${expanded ? styles.chevOpen : ''}`}
        />
        <span className={styles.label}>{label}</span>
      </button>

      {streaming && !expanded && hasRunningCall && (
        <span className={styles.runTrack} aria-hidden="true">
          <span className={styles.runHalo} />
          <span className={styles.runCore} />
        </span>
      )}

      <div className={`${styles.panel} ${expanded ? styles.panelExpanded : ''}`}>
        <div className={styles.panelInner}>
          <div className={styles.steps}>
            {resolvedComparison && <VisualComparison pair={resolvedComparison} />}
            {segments.map((segment, index) =>
              segment.type === 'thinking' ? (
                <ThoughtsSection
                  key={`thinking-${index}`}
                  thinking={segment.text}
                  streaming={streaming && index === segments.length - 1}
                />
              ) : (
                segment.calls.map((call) => <ToolCallCard key={call.id} call={call} />)
              )
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
