import type { ConversationGoal } from '@shared/conversation.types'
import type { Plan } from '@shared/plan.types'
import { Icon } from '../../../components/Icon'
import styles from '../ChatComposer.module.css'

interface ComposerGoalBarProps {
  goal: ConversationGoal
  plan?: Plan | null
}

function goalProgress(plan?: Plan | null): string {
  if (!plan || plan.steps.length === 0) return 'In progress'
  const completed = plan.steps.filter((step) => step.status === 'completed').length
  if (completed === plan.steps.length) return 'Complete'
  return `${completed}/${plan.steps.length} steps`
}

/** A persistent, compact reminder of the outcome currently guiding this chat. */
export function ComposerGoalBar({ goal, plan }: ComposerGoalBarProps): JSX.Element {
  const progress = goalProgress(plan)
  const complete = progress === 'Complete'

  return (
    <div className={styles.goalBar} aria-label={`Goal: ${goal.title}. ${progress}.`}>
      <Icon name="slash-goal" size={16} />
      <span className={styles.goalLabel}>Goal</span>
      <span className={styles.goalTitle} title={goal.title}>
        {goal.title}
      </span>
      <span className={`${styles.goalProgress} ${complete ? styles.goalComplete : ''}`}>
        {complete && <Icon name="check" size={12} />}
        {progress}
      </span>
    </div>
  )
}
