import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ModelReliabilityRecord } from '@shared/modelReliability.types'
import { computeReliabilityScore } from '@shared/modelReliability.types'
import styles from './AiModelsSettings.module.css'

interface PopoverPosition {
  top: number
  left: number
}

function countOutcomes(record: ModelReliabilityRecord | undefined): number {
  if (!record) return 0
  return Object.values(record.byTool).reduce(
    (total, stats) => total + stats.successes + stats.errors,
    0
  )
}

/**
 * Real observed reliability behind one compact score. Hovering the score shows
 * the per-tool breakdown; keyboard focus reveals the same information without
 * changing the table's height.
 */
export function ReliabilityScore({
  record,
  modelName
}: {
  record: ModelReliabilityRecord | undefined
  modelName: string
}): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState<PopoverPosition | null>(null)
  const tooltipId = useId()
  const score = computeReliabilityScore(record)
  const outcomes = countOutcomes(record)
  const toolEntries = record ? Object.entries(record.byTool) : []
  const visibleToolEntries = [...toolEntries]
    .sort(([, a], [, b]) => b.successes + b.errors - (a.successes + a.errors))
    .slice(0, 5)
  const hiddenToolCount = toolEntries.length - visibleToolEntries.length

  if (score === null) {
    return (
      <div className={styles.reliabilityUnavailable}>
        <strong>No usage yet</strong>
        <small>Score after 3 outcomes</small>
      </div>
    )
  }

  const showPopover = (): void => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const estimatedHeight = 172 + visibleToolEntries.length * 26 + (hiddenToolCount > 0 ? 24 : 0)
    const fitsBelow = rect.bottom + 8 + estimatedHeight < window.innerHeight
    setPosition({
      top: fitsBelow ? rect.bottom + 8 : Math.max(8, rect.top - estimatedHeight - 8),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 288))
    })
  }

  const hidePopover = (): void => setPosition(null)

  return (
    <div className={styles.reliabilityAnchor} onMouseEnter={showPopover} onMouseLeave={hidePopover}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.reliabilityScoreButton}
        aria-label={`${modelName} tool reliability: ${score} out of 100. Hover for details.`}
        aria-describedby={position ? tooltipId : undefined}
        onFocus={showPopover}
        onBlur={hidePopover}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.blur()
        }}
      >
        <strong>{score} / 100</strong>
        <small>
          {outcomes} outcome{outcomes === 1 ? '' : 's'}
        </small>
      </button>

      {position &&
        createPortal(
          <div
            id={tooltipId}
            role="tooltip"
            className={styles.reliabilityPopover}
            style={{ top: position.top, left: position.left }}
          >
            <div className={styles.reliabilityPopoverHead}>
              <div>
                <span>Observed tool reliability</span>
                <strong>{modelName}</strong>
              </div>
              <span className={styles.reliabilityPopoverScore}>{score}</span>
            </div>
            <div className={styles.reliabilityPopoverTools}>
              {visibleToolEntries.map(([tool, stats]) => {
                const total = stats.successes + stats.errors
                return (
                  <div key={tool}>
                    <span>{tool}</span>
                    <strong>
                      {stats.successes} / {total}
                    </strong>
                  </div>
                )
              })}
            </div>
            {hiddenToolCount > 0 && (
              <div className={styles.reliabilityPopoverMore}>
                +{hiddenToolCount} more tool{hiddenToolCount === 1 ? '' : 's'} included in this
                score
              </div>
            )}
            <div className={styles.reliabilityPopoverFoot}>
              <span>Fabricated outcomes</span>
              <strong className={record?.fabrications ? styles.reliabilityWarning : undefined}>
                {record?.fabrications ?? 0}
              </strong>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
