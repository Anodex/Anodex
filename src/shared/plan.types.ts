/** Types for the assistant's visible, self-tracked task plan. */

/** Status of a single step in a plan. */
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed'

export interface PlanStep {
  id: string
  title: string
  status: PlanStepStatus
}

/**
 * A structured task plan the assistant authors and updates while working on a
 * multi-step request, shown live in the Workspace Dock's Plan panel so the
 * user can track progress without reading the whole transcript. Scoped to a
 * single conversation — created via the `write_plan` tool, kept current via
 * `update_plan_step`.
 */
export interface Plan {
  title: string
  steps: PlanStep[]
  updatedAt: number
}
