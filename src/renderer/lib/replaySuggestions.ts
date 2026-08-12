import type { Plan } from '@shared/plan.types'

/**
 * Return an immediate, trustworthy next-action suggestion from the visible
 * plan. This deliberately beats the optional model-generated suggestion: an
 * unfinished plan step is authoritative state, while generated copy is only a
 * convenience once there is no plan to follow.
 */
export function suggestionFromPlan(plan: Plan | null | undefined): string | null {
  if (!plan) return null
  const index = plan.steps.findIndex((step) => step.status !== 'completed')
  if (index === -1) return null

  const title = plan.steps[index].title.replace(/\s+/g, ' ').trim()
  if (!title) return null
  const step = /^phase\b/i.test(title) ? title : `step ${index + 1}: ${title}`
  return `Start working on ${step}.`
}
