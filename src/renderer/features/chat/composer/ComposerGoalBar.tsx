import type { ConversationGoal } from '@shared/conversation.types'
import type { Plan } from '@shared/plan.types'
import { Icon } from '../../../components/Icon'
import styles from '../ChatComposer.module.css'

interface ComposerGoalBarProps {
  goal: ConversationGoal
  plan?: Plan | null
  /** True while a generation for this chat is in flight. */
  running?: boolean
  /** Stop the in-flight goal run. Same abort the composer's Stop button uses. */
  onStop?: () => void
  /** Drop the goal marker, ending autonomy for subsequent messages. */
  onClear?: () => void
}

interface GoalState {
  label: string
  detail?: string
  tone: 'running' | 'done' | 'stalled'
}

/**
 * What the bar says, in priority order: what the run is doing now, then what it
 * concluded, then how far the plan got.
 *
 * The plan fallback is deliberately last. It used to be the *only* thing shown,
 * which meant the bar reported "3/4 steps" while the goal itself was nowhere
 * near met — plan rows are the model's own bookkeeping, not evidence. A goal
 * now reports its own outcome, and step counts are only a rough progress hint
 * while nothing better exists.
 */
function goalState(goal: ConversationGoal, running: boolean, plan?: Plan | null): GoalState {
  if (running) return { label: 'Working', tone: 'running' }
  if (goal.status === 'finished') {
    return { label: 'Done', detail: goal.summary, tone: 'done' }
  }
  if (goal.status === 'unfinished') {
    return { label: 'Unfinished', detail: goal.blockedReason, tone: 'stalled' }
  }
  if (plan && plan.steps.length > 0) {
    const completed = plan.steps.filter((step) => step.status === 'completed').length
    return { label: `${completed}/${plan.steps.length} steps`, tone: 'running' }
  }
  return { label: 'Active', tone: 'running' }
}

/**
 * A persistent, compact record of the outcome guiding this chat, and how the
 * run pursuing it is doing.
 */
export function ComposerGoalBar({
  goal,
  plan,
  running = false,
  onStop,
  onClear
}: ComposerGoalBarProps): JSX.Element {
  const state = goalState(goal, running, plan)
  const statusClass =
    state.tone === 'done' ? styles.goalComplete : state.tone === 'stalled' ? styles.goalStalled : ''

  return (
    <div
      className={styles.goalBar}
      aria-label={`Goal: ${goal.title}. ${state.label}.${state.detail ? ` ${state.detail}` : ''}`}
    >
      <Icon name="slash-goal" size={16} />
      <span className={styles.goalLabel}>Goal</span>
      <span className={styles.goalTitle} title={goal.title}>
        {goal.title}
      </span>
      <span className={`${styles.goalProgress} ${statusClass}`} title={state.detail ?? undefined}>
        {state.tone === 'done' && <Icon name="check" size={12} />}
        {state.label}
      </span>
      {/* A goal run takes many cycles on its own, so stopping it must never be
          more than one click away — the reason this ships with the raised
          cycle budget rather than after it. */}
      {running && onStop && (
        <button
          type="button"
          className={styles.goalAction}
          onClick={onStop}
          aria-label="Stop the goal run"
        >
          Stop
        </button>
      )}
      {!running && onClear && (
        <button
          type="button"
          className={styles.goalAction}
          onClick={onClear}
          aria-label="Clear this goal"
        >
          Clear
        </button>
      )}
    </div>
  )
}
