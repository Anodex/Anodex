import { useEffect, useRef, useState } from 'react'
import type {
  CriticalThinkingActivity,
  CriticalThinkingRoundStatus,
  CriticalThinkingRun,
  CriticalThinkingStepState
} from '@shared/criticalThinking.types'
import { Icon } from '../../components/Icon'
import { Spinner } from '../../components/ui/Spinner'
import styles from './CriticalThinkingView.module.css'

const COLLAPSED_ACTIVITY_COUNT = 20

const ROUND_STATUS_LABEL: Record<CriticalThinkingRoundStatus, string> = {
  querying: 'Choosing searches',
  searching: 'Searching the web',
  reading: 'Reading selected sources',
  assessing: 'Checking evidence coverage',
  completed: 'Round complete',
  limited: 'Round limit reached',
  stopped: 'Round stopped',
  failed: 'Round failed'
}

interface CriticalThinkingProgressProps {
  run: CriticalThinkingRun
}

/** How many recent research actions the current step shows before folding the rest. */
const STEP_ACTIVITY_COUNT = 6

/**
 * Research in progress as one list of steps.
 *
 * It was four boxes saying overlapping things: the plan, a live activity list, an
 * evidence trail and a status line repeating "Step 2 of 3 · Round 1". The steps
 * are the structure; the searching and reading happening now sit under the step
 * they belong to, and a finished step keeps a line of what it found.
 */
export function CriticalThinkingProgress({ run }: CriticalThinkingProgressProps): JSX.Element {
  const researching = run.status === 'researching'
  const writing = run.status === 'synthesizing' || run.status === 'validating'

  return (
    <ol className={styles.spine} aria-live="polite">
      {run.plan!.steps.map((planStep, index) => {
        const step = run.steps[index]
        const status = displayStatus(step, planStep.status, index === run.currentStep)
        const current = researching && index === run.currentStep
        return (
          <li key={planStep.id} className={`${styles.spineStep} ${styles[`spine-${status}`]}`}>
            <span className={styles.spineMark}>
              {status === 'completed' ? (
                <Icon name="check" size={11} />
              ) : status === 'limited' ? (
                <Icon name="alert" size={11} />
              ) : status === 'in_progress' ? (
                <Spinner size={11} />
              ) : null}
            </span>
            <div className={styles.spineBody}>
              <span className={styles.spineTitle}>{planStep.title}</span>
              <StepLine step={step} status={status} current={current} />
              {current && step && <CurrentStep step={step} activities={run.activities} />}
            </div>
          </li>
        )
      })}
      {writing && (
        <li className={`${styles.spineStep} ${styles['spine-in_progress']}`}>
          <span className={styles.spineMark}>
            <Spinner size={11} />
          </span>
          <div className={styles.spineBody}>
            <span className={styles.spineTitle}>Writing the report</span>
            <span className={styles.spineLine}>
              {run.status === 'validating'
                ? 'Checking every claim against its source'
                : 'Drafting from the pages it read'}
            </span>
          </div>
        </li>
      )}
    </ol>
  )
}

type StepStatus = 'completed' | 'limited' | 'in_progress' | 'pending'

function displayStatus(
  step: CriticalThinkingStepState | undefined,
  planStatus: string,
  isCurrent: boolean
): StepStatus {
  if (step?.status === 'completed') return 'completed'
  if (step?.status === 'limited' || step?.status === 'failed') return 'limited'
  if (isCurrent && step?.status === 'researching') return 'in_progress'
  return planStatus === 'completed'
    ? 'completed'
    : planStatus === 'in_progress'
      ? 'in_progress'
      : 'pending'
}

/** The one line under a step: what it found, what it is doing, or why it stopped. */
function StepLine({
  step,
  status,
  current
}: {
  step: CriticalThinkingStepState | undefined
  status: StepStatus
  current: boolean
}): JSX.Element | null {
  if (!step) return null
  if (current) {
    const round = step.rounds.at(-1)
    if (!round) return <span className={styles.spineLine}>Choosing what to search for</span>
    const assessment = [...step.rounds].reverse().find((entry) => entry.assessment)?.assessment
    return (
      <span className={styles.spineLine}>
        Round {round.index + 1} · {ROUND_STATUS_LABEL[round.status].toLowerCase()}
        {assessment
          ? assessment.verdict === 'sufficient'
            ? ' · enough evidence'
            : ' · needs more evidence'
          : ''}
      </span>
    )
  }
  if (status === 'completed' && step.finding.trim()) {
    return <span className={styles.spineLine}>{firstSentence(step.finding)}</span>
  }
  if (status === 'limited' && step.uncertainties.length > 0) {
    return (
      <span className={styles.spineLine}>
        Still missing: {step.uncertainties.slice(0, 2).join(' · ')}
      </span>
    )
  }
  return null
}

/** The step being researched: its searches, and the reading happening now. */
function CurrentStep({
  step,
  activities
}: {
  step: CriticalThinkingStepState
  activities: CriticalThinkingActivity[]
}): JSX.Element {
  const round = step.rounds.at(-1)
  const assessment = [...step.rounds].reverse().find((entry) => entry.assessment)?.assessment
  const gaps = assessment?.remainingGaps.length ? assessment.remainingGaps : step.uncertainties
  return (
    <div className={styles.spineNow}>
      {round && round.queries.length > 0 && (
        <div className={styles.spineQueries} aria-label="Searches this round">
          {round.queries.map((query) => (
            <span key={query}>{query}</span>
          ))}
        </div>
      )}
      <ActivityTimeline activities={activities} limit={STEP_ACTIVITY_COUNT} />
      {gaps.length > 0 && (
        <span className={styles.spineLine}>Still looking for: {gaps.slice(0, 2).join(' · ')}</span>
      )}
    </div>
  )
}

/** The first sentence of a finding, for the line under a finished step. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const end = flat.search(/[.!?](\s|$)/)
  const sentence = end > 0 ? flat.slice(0, end + 1) : flat
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence
}

/**
 * The id of the item that has just appeared at the end of a growing list, or
 * null.
 *
 * Only an arrival this component *watches* is flagged: on first mount the whole
 * list is history, however recent, so opening a run mid-research must not write
 * in its last row as though it just happened. Re-rendering for any other reason
 * — scrolling, expanding earlier rows — leaves the flag where it is, because
 * nothing new arrived.
 */
function useNewestId(items: { id: string }[]): string | null {
  const [newestId, setNewestId] = useState<string | null>(null)
  const seenRef = useRef<string | null>(null)

  useEffect(() => {
    const latest = items.at(-1)?.id ?? null
    if (latest === null) return
    if (seenRef.current !== null && seenRef.current !== latest) setNewestId(latest)
    seenRef.current = latest
  }, [items])

  return newestId
}

export function ActivityTimeline({
  activities,
  limit = COLLAPSED_ACTIVITY_COUNT
}: {
  activities: CriticalThinkingActivity[]
  /** How many recent actions show before the rest fold away. */
  limit?: number
}): JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const newestId = useNewestId(activities)
  if (activities.length === 0) {
    return <p className={styles.activityEmpty}>Waiting for the first research action…</p>
  }
  const hiddenCount = Math.max(0, activities.length - limit)
  const visible = showAll ? activities : activities.slice(-limit)
  return (
    <div className={styles.activityList}>
      {hiddenCount > 0 && (
        <button
          type="button"
          className={styles.activityToggle}
          onClick={() => setShowAll((visible) => !visible)}
        >
          {showAll ? 'Show recent activity only' : `Show ${hiddenCount} earlier activities`}
        </button>
      )}
      {visible.map((activity) => (
        <div
          key={activity.id}
          className={`${styles.activityRow} ${
            activity.id === newestId ? styles.activityArrived : ''
          }`}
        >
          <span className={styles.activityIcon}>
            {activity.status === 'running' ? (
              <Spinner size={11} />
            ) : activity.status === 'success' ? (
              <Icon name="check" size={11} />
            ) : activity.status === 'error' ? (
              <Icon name="alert" size={11} />
            ) : (
              <Icon name="circle" size={11} />
            )}
          </span>
          <span className={styles.activityLabel}>{activity.label}</span>
          {activity.detail && <span className={styles.activityDetail}>{activity.detail}</span>}
        </div>
      ))}
    </div>
  )
}
