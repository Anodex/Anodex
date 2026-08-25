import { useEffect, useRef, useState } from 'react'
import type { RenderSegment } from './taskPhase'
import { Icon } from '../../components/Icon'
import { formatDuration } from '../../lib/format'
import { ThoughtsSection } from './ThoughtsSection'
import { ToolCallCard } from './ToolCallCard'
import { MessageContent } from './MessageContent'
import { VisualComparison } from './VisualComparison'
import { latestVisualComparison, type VisualComparisonPair } from './visualComparisonPair'
import { summarizeWork } from './summarizeWork'
import styles from './TurnRecap.module.css'

/**
 * Anything a collapsed run can contain. Prose is included because a settled
 * reply folds its narration in too -- see `foldSettledTimeline`.
 */
type WorkSegment = RenderSegment

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
  // A settled reply opens collapsed, including one already on screen when a
  // chat is reopened. See the settle effect below for why a visual result no
  // longer forces it open.
  const [expanded, setExpanded] = useState(streaming)
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
  //
  // A turn that produced an image used to stay open, from when a screenshot
  // was rare and was the point of the turn. `inspect_visual` is now routine --
  // Anodex looks at its own render most turns -- so that exception had grown
  // to mean "almost never collapse", which is the opposite of what a finished
  // reply wants. The image is one click away, and the summary is what a reader
  // needs first.
  useEffect(() => {
    if (wasStreaming.current && !streaming) {
      setSettledMs(Date.now() - startedAt)
      wasStreaming.current = streaming
      const timer = setTimeout(() => setExpanded(false), 900)
      return () => clearTimeout(timer)
    }
    wasStreaming.current = streaming
    return undefined
  }, [streaming, startedAt])

  const hasRunningCall = calls.some((call) => call.status === 'running')
  const elapsedMs = streaming ? Date.now() - startedAt : (finalDurationMs ?? settledMs ?? 0)
  // Named from the settled calls rather than left as "Work details", which
  // told the reader nothing about whether a turn read one file or rewrote six.
  const work = summarizeWork(calls)
  const label = streaming
    ? `Working for ${formatDuration(elapsedMs)}`
    : showTotalDuration
      ? `Worked for ${formatDuration(elapsedMs)}${work ? ` · ${work}` : ''}`
      : (work ?? 'Work details')

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
            {segments.map((segment, index) => {
              if (segment.type === 'thinking') {
                return (
                  <ThoughtsSection
                    key={`thinking-${index}`}
                    thinking={segment.text}
                    streaming={streaming && index === segments.length - 1}
                  />
                )
              }
              // Narration the model wrote between calls. Rendered as the prose
              // it is, so expanding a folded reply reads the way it did live.
              if (segment.type === 'text') {
                return <MessageContent key={`text-${index}`} content={segment.text} />
              }
              return segment.calls.map((call) => <ToolCallCard key={call.id} call={call} />)
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
