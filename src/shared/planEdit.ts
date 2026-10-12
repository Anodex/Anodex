import type { Plan } from './plan.types'

/** A plan anyone could still read at a glance, and the model could still follow. */
export const MAX_EDITED_PLAN_STEPS = 30
export const MAX_PLAN_STEP_CHARS = 300

/**
 * A plan a person edited before approving it, checked and made pending.
 *
 * It crosses IPC, so its shape is not trusted: anything that is not a list of
 * one to thirty non-empty titles is refused (null) rather than repaired, and the
 * run carries on with the plan it proposed. Every step starts pending, because
 * nothing in an unapproved run has been done.
 */
export function acceptEditedPlan(value: unknown, original: Plan): Plan | null {
  if (typeof value !== 'object' || value === null) return null
  const steps = (value as { steps?: unknown }).steps
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_EDITED_PLAN_STEPS) {
    return null
  }
  const accepted: Plan['steps'] = []
  for (const step of steps) {
    if (typeof step !== 'object' || step === null) return null
    const { id, title } = step as { id?: unknown; title?: unknown }
    if (typeof title !== 'string') return null
    const trimmed = title.trim()
    if (!trimmed || trimmed.length > MAX_PLAN_STEP_CHARS) return null
    accepted.push({
      id: typeof id === 'string' && id ? id : `step-${accepted.length + 1}-${Date.now()}`,
      title: trimmed,
      status: 'pending'
    })
  }
  return { ...original, steps: accepted, updatedAt: Date.now() }
}

/** Whether an edited plan differs from the proposal in anything the model would read. */
export function planTitlesChanged(before: Plan, after: Plan): boolean {
  return (
    before.steps.length !== after.steps.length ||
    before.steps.some((step, index) => step.title !== after.steps[index].title)
  )
}
