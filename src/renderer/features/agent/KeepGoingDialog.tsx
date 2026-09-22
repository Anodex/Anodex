import { useState, type JSX } from 'react'
import type { AgentRun } from '@shared/agentRun.types'
import { seriesIdOf } from '@shared/agentRun.types'
import type { TaskRecurrence } from '@shared/scheduledTask.types'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/ui/Button'
import { Overlay } from '../../components/ui/Overlay'
import { WhenField } from '../scheduler/WhenField'
import { useSchedulerStore } from '../../stores/schedulerStore'
import { goalHeadline } from './agentRunFormat'
import styles from './KeepGoingDialog.module.css'

/**
 * Turn a finished run into ongoing work that advances on its own.
 *
 * Until this, a series only moved when somebody pressed Continue — which made
 * "keep this up to date" a thing you had to remember, and an assistant you
 * have to remember to press is a button.
 *
 * It creates an ordinary scheduled task rather than a second kind of schedule
 * living in the Agent panel. Everything the Scheduler already does then
 * applies for free: the same When field, the same run history, the same
 * enable/disable and delete, the same keep-awake. There is one place to look
 * for "what is this machine going to do on its own", which matters more for
 * unattended work than for anything else in the app.
 */
export function KeepGoingDialog({
  run,
  onClose
}: {
  run: AgentRun
  onClose: () => void
}): JSX.Element {
  const createTask = useSchedulerStore((state) => state.create)
  const [text, setText] = useState('every day at 9am')
  const [recurrence, setRecurrence] = useState<TaskRecurrence>({
    type: 'daily',
    hour: 9,
    minute: 0
  })
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    setSaving(true)
    const task = await createTask({
      name: goalHeadline(run.goal),
      // The goal is not the prompt: a continuation reads the run's goal off
      // the series when it fires, so storing a copy here would be a second
      // version of the same sentence, free to drift.
      prompt: '',
      projectId: run.projectId,
      recurrence,
      enabledTools: [],
      continuesSeriesId: seriesIdOf(run)
    })
    setSaving(false)
    if (task) onClose()
  }

  return (
    <Overlay onClose={onClose} ariaLabel="Keep this work going" cardClassName={styles.card}>
      <div className={styles.header}>
        <h2 className={styles.title}>Keep this work going</h2>
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className={styles.body}>
        <p className={styles.goal}>{goalHeadline(run.goal)}</p>
        <p className={styles.note}>
          Anodex will start the next run of this work on the schedule below, each one picking up
          from the journal the ones before it wrote. It uses whatever the most recent run used — the
          same provider, tools and budgets — so changing those by continuing by hand changes this
          too.
        </p>

        <WhenField value={recurrence} onChange={setRecurrence} text={text} onTextChange={setText} />

        {run.requirePlan && (
          <p className={styles.warn}>
            <Icon name="eye" size={12} />
            This work asks for plan review, so every scheduled run will stop and wait for you before
            it does anything. Continue it once with review turned off if you want it to run
            unattended.
          </p>
        )}
        <p className={styles.note}>
          It appears in <strong>Scheduler</strong>, where you can pause or delete it — and a run
          only starts if the last one has finished, so these cannot pile up.
        </p>
      </div>

      <div className={styles.footer}>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void submit()} loading={saving}>
          <Icon name="clock" size={14} />
          Schedule it
        </Button>
      </div>
    </Overlay>
  )
}
