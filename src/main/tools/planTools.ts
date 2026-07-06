import { randomUUID } from 'node:crypto'
import type { Plan, PlanStep } from '@shared/plan.types'
import type { ToolFactory } from './types'
import { runReadTool } from './helpers'

const MAX_STEPS = 30
const MAX_TITLE_CHARS = 200

/**
 * write_plan / update_plan_step — a lightweight, visible task list the
 * assistant authors and keeps current while working on a multi-step request.
 * Rendered live in the user's Workspace Dock (Plan panel), so they can see
 * progress without reading the whole transcript. Pure in-memory bookkeeping —
 * no filesystem/command access — so these never need approval under any
 * permission mode, unlike file or command tools.
 */
export const writePlanTool: ToolFactory = (define, ctx) =>
  define({
    description:
      "Create or replace the visible task plan for this conversation, shown in the user's Workspace Dock. Use this once at the start of a multi-step request so the user can track progress; call it again to replace the whole plan if the approach changes.",
    params: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name for the overall plan.' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered list of step titles, each a short one-line description.'
        }
      },
      required: ['title', 'steps']
    } as const,
    handler: (args: { title: string; steps: string[] }) =>
      runReadTool(ctx, {
        name: 'write_plan',
        kind: 'plan',
        title: `Plan: ${truncate(args.title, 60)}`,
        run() {
          const steps: PlanStep[] = args.steps.slice(0, MAX_STEPS).map((title) => ({
            id: randomUUID(),
            title: truncate(title, MAX_TITLE_CHARS),
            status: 'pending'
          }))
          const plan: Plan = { title: args.title, steps, updatedAt: Date.now() }
          ctx.plan.current = plan
          return Promise.resolve({
            modelResult: `Plan created with ${steps.length} step(s).`,
            detail: `${steps.length} steps`,
            plan
          })
        }
      })
  })

export const updatePlanStepTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Mark a step of the current plan as in progress or completed. Refer to the step by its 1-based position in the plan (as returned by write_plan).',
    params: {
      type: 'object',
      properties: {
        stepNumber: { type: 'number', description: '1-based position of the step in the plan.' },
        status: {
          enum: ['in_progress', 'completed'],
          description: 'New status for the step.'
        }
      },
      required: ['stepNumber', 'status']
    } as const,
    handler: (args: { stepNumber: number; status: 'in_progress' | 'completed' }) =>
      runReadTool(ctx, {
        name: 'update_plan_step',
        kind: 'plan',
        title: `Update plan step ${args.stepNumber}`,
        run() {
          const plan = ctx.plan.current
          if (!plan) throw new Error('No plan exists yet. Call write_plan first.')
          const step = plan.steps[args.stepNumber - 1]
          if (!step) {
            throw new Error(
              `No step ${args.stepNumber} in the current plan (it has ${plan.steps.length}).`
            )
          }
          step.status = args.status
          plan.updatedAt = Date.now()
          return Promise.resolve({
            modelResult: `Step ${args.stepNumber} ("${step.title}") marked ${args.status}.`,
            detail: step.title,
            plan
          })
        }
      })
  })

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
