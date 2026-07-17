import type { PlanStep, PlanStepStatus } from '@shared/plan.types'
import { Icon } from '../../../components/Icon'
import { Spinner } from '../../../components/ui/Spinner'
import { useChatStore } from '../../../stores/chatStore'
import { WorkspaceDockPanel } from '../WorkspaceDockPanel'
import styles from './PlanPanel.module.css'

/**
 * Shows the active conversation's self-tracked task plan — authored via the
 * `write_plan` tool and kept current via `update_plan_step` — so the user can
 * see progress on a multi-step request without reading the whole transcript.
 * Purely a mirror of assistant-driven state; there's no manual check-off here
 * by design, since the point is to see what the AI itself believes is done.
 */
export function PlanPanel(): JSX.Element {
  const activeId = useChatStore((s) => s.activeId)
  const plan = useChatStore((s) => s.conversations.find((c) => c.id === activeId)?.plan)

  if (!plan || plan.steps.length === 0) {
    return <WorkspaceDockPanel title="Plan">No active plan for this session.</WorkspaceDockPanel>
  }

  const completed = plan.steps.filter((step) => step.status === 'completed').length

  return (
    <WorkspaceDockPanel title="Plan">
      <div className={styles.header}>
        <span className={styles.title}>{plan.title}</span>
        <span className={styles.count}>
          {completed}/{plan.steps.length}
        </span>
      </div>
      <ul className={styles.steps}>
        {plan.steps.map((step, index) => (
          <PlanStepRow key={step.id} step={step} index={index} />
        ))}
      </ul>
    </WorkspaceDockPanel>
  )
}

function PlanStepRow({ step, index }: { step: PlanStep; index: number }): JSX.Element {
  return (
    <li className={`${styles.step} ${styles[step.status]}`}>
      <span className={styles.stepIcon}>
        <StepStatusIcon status={step.status} />
      </span>
      <span className={styles.stepTitle}>
        {index + 1}. {stripLeadingOrdinal(step.title)}
      </span>
    </li>
  )
}

/**
 * Models sometimes write their own "1. "/"2) " prefix into a step title even
 * though `write_plan`'s schema just asks for a short description — the row
 * already renders its own `index + 1`, so a model-written prefix would
 * otherwise show up doubled (e.g. "1. 1. Add sound effects...").
 */
function stripLeadingOrdinal(title: string): string {
  return title.replace(/^\d+[.)]\s+/, '')
}

function StepStatusIcon({ status }: { status: PlanStepStatus }): JSX.Element {
  if (status === 'completed') return <Icon name="check" size={13} />
  if (status === 'in_progress') return <Spinner size={12} />
  return <Icon name="circle" size={13} />
}
