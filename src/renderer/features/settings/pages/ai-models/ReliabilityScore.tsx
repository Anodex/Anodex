import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ModelReliabilityRecord, ToolReliabilityStats } from '@shared/modelReliability.types'
import { computeReliabilityScore } from '@shared/modelReliability.types'
import styles from './AiModelsSettings.module.css'

interface PopoverPosition {
  top: number
  left: number
}

type ToolEntry = [string, ToolReliabilityStats]

function countOutcomes(record: ModelReliabilityRecord | undefined): number {
  if (!record) return 0
  return Object.values(record.byTool).reduce(
    (total, stats) => total + stats.successes + stats.errors,
    0
  )
}

function toolSuccessRate(stats: ToolReliabilityStats): number {
  const total = stats.successes + stats.errors
  return total === 0 ? 0 : Math.round((stats.successes / total) * 100)
}

function sortToolEntries(record: ModelReliabilityRecord | undefined): ToolEntry[] {
  if (!record) return []
  return Object.entries(record.byTool).sort(
    ([, a], [, b]) => b.successes + b.errors - (a.successes + a.errors)
  )
}

/**
 * Real observed reliability behind one compact score. Hovering shows every
 * observed tool in a scrollable card; clicking opens a persistent full report.
 */
export function ReliabilityScore({
  record,
  modelName
}: {
  record: ModelReliabilityRecord | undefined
  modelName: string
}): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const hideTimerRef = useRef<number | null>(null)
  const [position, setPosition] = useState<PopoverPosition | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const popoverTitleId = useId()
  const dialogTitleId = useId()
  const score = computeReliabilityScore(record)
  const outcomes = countOutcomes(record)
  const toolEntries = sortToolEntries(record)

  const cancelScheduledHide = (): void => {
    if (hideTimerRef.current === null) return
    window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = null
  }

  const hidePopover = (): void => {
    cancelScheduledHide()
    setPosition(null)
  }

  const schedulePopoverHide = (): void => {
    cancelScheduledHide()
    hideTimerRef.current = window.setTimeout(() => {
      setPosition(null)
      hideTimerRef.current = null
    }, 140)
  }

  const showPopover = (): void => {
    if (dialogOpen) return
    cancelScheduledHide()
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const estimatedHeight = Math.min(430, 184 + toolEntries.length * 30)
    const fitsBelow = rect.bottom + 8 + estimatedHeight < window.innerHeight
    setPosition({
      top: fitsBelow ? rect.bottom + 8 : Math.max(8, rect.top - estimatedHeight - 8),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 328))
    })
  }

  const openDialog = (): void => {
    hidePopover()
    setDialogOpen(true)
  }

  const closeDialog = (): void => {
    setDialogOpen(false)
    window.requestAnimationFrame(() => buttonRef.current?.focus())
  }

  useEffect(() => {
    return () => cancelScheduledHide()
  }, [])

  useEffect(() => {
    if (!dialogOpen) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeDialog()
    }
    document.addEventListener('keydown', handleKeyDown)
    window.requestAnimationFrame(() => dialogRef.current?.focus())
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [dialogOpen])

  if (score === null) {
    return (
      <div className={styles.reliabilityUnavailable}>
        <strong>No usage yet</strong>
        <small>Score after 3 outcomes</small>
      </div>
    )
  }

  return (
    <div
      className={styles.reliabilityAnchor}
      onMouseEnter={showPopover}
      onMouseLeave={schedulePopoverHide}
    >
      <button
        ref={buttonRef}
        type="button"
        className={styles.reliabilityScoreButton}
        aria-label={`${modelName} tool reliability: ${score} out of 100. Hover for the full list or click to expand.`}
        aria-haspopup="dialog"
        aria-expanded={dialogOpen}
        onClick={openDialog}
        onFocus={showPopover}
        onBlur={(event) => {
          if (popoverRef.current?.contains(event.relatedTarget)) return
          schedulePopoverHide()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') hidePopover()
        }}
      >
        <strong>{score} / 100</strong>
        <small>
          {outcomes} outcome{outcomes === 1 ? '' : 's'} · click to expand
        </small>
      </button>

      {position &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-labelledby={popoverTitleId}
            className={styles.reliabilityPopover}
            style={{ top: position.top, left: position.left }}
            onMouseEnter={cancelScheduledHide}
            onMouseLeave={schedulePopoverHide}
          >
            <div className={styles.reliabilityPopoverHead}>
              <div>
                <span>Observed tool reliability</span>
                <strong id={popoverTitleId}>{modelName}</strong>
              </div>
              <span className={styles.reliabilityPopoverScore}>{score}</span>
            </div>
            <div
              className={styles.reliabilityPopoverScroll}
              tabIndex={0}
              aria-label={`All ${toolEntries.length} observed tools. Scroll for the complete list.`}
            >
              <div className={styles.reliabilityPopoverTools}>
                {toolEntries.map(([tool, stats]) => {
                  const total = stats.successes + stats.errors
                  return (
                    <div key={tool}>
                      <span>{tool}</span>
                      <span className={styles.reliabilityToolResult}>
                        <strong>
                          {stats.successes} / {total}
                        </strong>
                        <small>{toolSuccessRate(stats)}%</small>
                      </span>
                    </div>
                  )
                })}
              </div>
              <div className={styles.reliabilityPopoverFoot}>
                <span>Fabricated outcomes</span>
                <strong className={record?.fabrications ? styles.reliabilityWarning : undefined}>
                  {record?.fabrications ?? 0}
                </strong>
              </div>
            </div>
            <div className={styles.reliabilityPopoverActions}>
              <span>Scroll here or open the full report</span>
              <button type="button" onClick={openDialog}>
                Expand
              </button>
            </div>
          </div>,
          document.body
        )}

      {dialogOpen &&
        createPortal(
          <div
            className={styles.reliabilityDialogBackdrop}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeDialog()
            }}
          >
            <section
              ref={dialogRef}
              className={styles.reliabilityDialog}
              role="dialog"
              aria-modal="true"
              aria-labelledby={dialogTitleId}
              tabIndex={-1}
            >
              <header className={styles.reliabilityDialogHead}>
                <div>
                  <span>Observed tool reliability</span>
                  <h3 id={dialogTitleId}>{modelName}</h3>
                  <p>Every tool this model has attempted on this computer.</p>
                </div>
                <button type="button" onClick={closeDialog} aria-label="Close reliability report">
                  ×
                </button>
              </header>

              <div className={styles.reliabilityDialogSummary}>
                <div>
                  <span>Reliability score</span>
                  <strong>{score} / 100</strong>
                </div>
                <div>
                  <span>Observed outcomes</span>
                  <strong>{outcomes}</strong>
                </div>
                <div>
                  <span>Tools observed</span>
                  <strong>{toolEntries.length}</strong>
                </div>
                <div>
                  <span>Fabrications</span>
                  <strong className={record?.fabrications ? styles.reliabilityWarning : undefined}>
                    {record?.fabrications ?? 0}
                  </strong>
                </div>
              </div>

              <div className={styles.reliabilityDialogTable} role="table">
                <div className={styles.reliabilityDialogTableHead} role="row">
                  <span role="columnheader">Tool</span>
                  <span role="columnheader">Successful</span>
                  <span role="columnheader">Errors</span>
                  <span role="columnheader">Rate</span>
                </div>
                <div
                  className={styles.reliabilityDialogRows}
                  tabIndex={0}
                  aria-label="Scrollable reliability results"
                >
                  {toolEntries.map(([tool, stats]) => (
                    <div key={tool} role="row">
                      <strong role="cell">{tool}</strong>
                      <span role="cell">{stats.successes}</span>
                      <span role="cell">{stats.errors}</span>
                      <strong role="cell">{toolSuccessRate(stats)}%</strong>
                    </div>
                  ))}
                </div>
              </div>

              <footer className={styles.reliabilityDialogFoot}>
                <p>
                  Denied calls are excluded. Results come from this user’s actual tool outcomes.
                </p>
                <button type="button" onClick={closeDialog}>
                  Done
                </button>
              </footer>
            </section>
          </div>,
          document.body
        )}
    </div>
  )
}
