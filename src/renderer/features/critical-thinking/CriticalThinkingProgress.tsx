import { useEffect, useRef, useState } from 'react'
import type {
  CriticalThinkingActivity,
  CriticalThinkingRoundStatus,
  CriticalThinkingRun,
  CriticalThinkingStepState
} from '@shared/criticalThinking.types'
import type { Plan } from '@shared/plan.types'
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

/** Compact, bounded progress UI for the persisted staged-research state machine. */
export function CriticalThinkingProgress({ run }: CriticalThinkingProgressProps): JSX.Element {
  const step = run.steps[run.currentStep]
  const latestRound = step?.rounds.at(-1)
  const latestAssessment = step
    ? [...step.rounds].reverse().find((round) => round.assessment)?.assessment
    : undefined
  const remainingGaps = latestAssessment?.remainingGaps.length
    ? latestAssessment.remainingGaps
    : (step?.uncertainties ?? [])
  const researching = run.status === 'researching'

  return (
    <>
      <div className={styles.progressGrid}>
        <PlanProgress plan={run.plan!} steps={run.steps} currentStep={run.currentStep} />
        <div className={styles.activityCard}>
          <p className={styles.cardEyebrow}>Live activity</p>
          <ActivityTimeline activities={run.activities} />
        </div>
      </div>
      <div className={styles.researchHint} aria-live="polite">
        <Icon name={researching ? 'web' : 'pencil'} size={17} />
        <div className={styles.researchStatusText}>
          <span>
            {researching
              ? researchStatusLine(run, step, latestRound?.index)
              : 'Preparing and validating the evidence-backed report.'}
          </span>
          {researching && latestRound && (
            <span className={styles.roundStage}>
              {ROUND_STATUS_LABEL[latestRound.status]}
              {latestAssessment
                ? latestAssessment.verdict === 'sufficient'
                  ? ' · Coverage sufficient'
                  : ' · More evidence needed'
                : ''}
            </span>
          )}
          {researching && remainingGaps.length ? (
            <span className={styles.roundGaps}>
              Remaining: {remainingGaps.slice(0, 2).join(' · ')}
            </span>
          ) : null}
        </div>
      </div>
    </>
  )
}

interface PlanProgressProps {
  plan: Plan
  steps: CriticalThinkingStepState[]
  currentStep: number
}

function PlanProgress({ plan, steps, currentStep }: PlanProgressProps): JSX.Element {
  return (
    <div className={styles.planProgress}>
      <p className={styles.cardEyebrow}>Research plan</p>
      <h3>{plan.title}</h3>
      <ol className={styles.progressSteps}>
        {plan.steps.map((planStep, index) => {
          const step = steps[index]
          const round = step?.rounds.at(-1)
          const displayStatus =
            step?.status === 'completed'
              ? 'completed'
              : step?.status === 'limited' || step?.status === 'failed'
                ? 'limited'
                : index === currentStep && step?.status === 'researching'
                  ? 'in_progress'
                  : planStep.status
          return (
            <li key={planStep.id} className={styles[`step-${displayStatus}`]}>
              {displayStatus === 'in_progress' && (
                <span className={styles.stepComet} aria-hidden="true">
                  <span className={styles.stepCometHalo} />
                  <span className={styles.stepCometCore} />
                </span>
              )}
              <span className={styles.stepIcon}>
                {displayStatus === 'completed' ? (
                  <Icon name="check" size={12} />
                ) : displayStatus === 'limited' ? (
                  <Icon name="alert" size={12} />
                ) : displayStatus === 'in_progress' ? (
                  <Spinner size={11} />
                ) : (
                  <Icon name="circle" size={11} />
                )}
              </span>
              <span className={styles.stepContent}>
                <span>{planStep.title}</span>
                {index === currentStep && round && (
                  <span className={styles.stepRoundMeta}>
                    Round {round.index + 1} · {ROUND_STATUS_LABEL[round.status]}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/**
 * The id of the activity that has just appeared, or null.
 *
 * Only a row this component *watches* arrive is flagged: on first mount the
 * whole list is history, however recent, so opening a run mid-research must not
 * write in its last row as though it just happened. Re-rendering for any other
 * reason — scrolling, expanding the earlier activities — leaves the flag where
 * it is, because nothing new arrived.
 */
function useNewestActivity(activities: CriticalThinkingActivity[]): string | null {
  const [newestId, setNewestId] = useState<string | null>(null)
  const seenRef = useRef<string | null>(null)

  useEffect(() => {
    const latest = activities.at(-1)?.id ?? null
    if (latest === null) return
    if (seenRef.current !== null && seenRef.current !== latest) setNewestId(latest)
    seenRef.current = latest
  }, [activities])

  return newestId
}

export function ActivityTimeline({
  activities
}: {
  activities: CriticalThinkingActivity[]
}): JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const newestId = useNewestActivity(activities)
  if (activities.length === 0) {
    return <p className={styles.activityEmpty}>Waiting for the first research action…</p>
  }
  const hiddenCount = Math.max(0, activities.length - COLLAPSED_ACTIVITY_COUNT)
  const visible = showAll ? activities : activities.slice(-COLLAPSED_ACTIVITY_COUNT)
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

function researchStatusLine(
  run: CriticalThinkingRun,
  step: CriticalThinkingStepState | undefined,
  roundIndex: number | undefined
): string {
  const stepNumber = Math.min(run.currentStep + 1, run.steps.length)
  const round = roundIndex === undefined ? '' : ` · Round ${roundIndex + 1}`
  const evidence = step?.evidenceIds.length ? ` · ${step.evidenceIds.length} saved artifacts` : ''
  return `Step ${stepNumber} of ${run.steps.length}${round}${evidence}`
}
