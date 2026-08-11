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
      "Create or replace the visible task plan for this conversation, shown in the user's Workspace Dock. " +
      'Use this once at the start of a multi-step request so the user can track progress; call it again to ' +
      'replace the whole plan if the approach changes. A plan is in-memory and has NO slug or id — its steps ' +
      'are addressed only by their 1-based number, and the ONLY way to tick one off is update_plan_step. ' +
      'This is not propose_change: do not use update_change_task or archive_change on a plan.',
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
        args,
        run() {
          const title = args.title.trim()
          if (!title) throw new Error('A plan needs a non-empty title.')
          const stepTitles = args.steps
            .map((stepTitle) => stepTitle.trim())
            .filter((stepTitle) => stepTitle.length > 0)
            .slice(0, MAX_STEPS)
          // An empty plan is never useful — for a plan-reviewed agent run
          // specifically, it would otherwise enter `needs-review` with
          // nothing for the user to actually approve.
          if (stepTitles.length === 0) throw new Error('A plan needs at least one step.')

          // Local models can re-emit the same native call after seeing its
          // result. Replacing an identical plan used to reset every completed
          // row back to pending. A changed plan may still replace the old one;
          // an exact repeat is an idempotent reminder of current progress.
          const current = ctx.plan.current
          if (current && isSamePlan(current, title, stepTitles)) {
            return Promise.resolve({
              modelResult:
                `That identical plan is already active; its progress was preserved:\n${renderPlan(current)}\n\n` +
                'Do not call write_plan again. Continue with update_plan_step using these same 1-based numbers.',
              detail: 'Existing plan preserved',
              plan: current
            })
          }

          const steps: PlanStep[] = stepTitles.map((stepTitle) => ({
            id: randomUUID(),
            title: truncate(stepTitle, MAX_TITLE_CHARS),
            status: 'pending'
          }))
          const plan: Plan = { title, steps, updatedAt: Date.now() }
          ctx.plan.current = plan
          // Echo the numbered steps and the exact follow-up call back to the
          // model. Local models routinely lose track of which step number maps
          // to which title several tool calls later, and then either stop
          // updating the plan or reach for a similarly-named tool
          // (`update_change_task`) — having the contract restated in-context
          // right where the plan is created is what keeps the ticking honest.
          const numbered = steps.map((step, index) => `${index + 1}. ${step.title}`).join('\n')
          return Promise.resolve({
            modelResult:
              `Plan created with ${steps.length} step(s):\n${numbered}\n\n` +
              'As you work, call update_plan_step({ stepNumber, status }) — status "in_progress" when ' +
              'you start a step and "completed" the moment you finish it, before moving to the next one. ' +
              'stepNumber is the 1-based number above. This plan has no slug; update_plan_step is the ' +
              'only tool that can tick these steps off.',
            detail: `${steps.length} steps`,
            plan
          })
        }
      })
  })

export const updatePlanStepTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Mark a step of the current write_plan plan as in progress or completed, updating the plan the user ' +
      'sees in their Workspace Dock. Refer to the step by its 1-based position (as returned by write_plan). ' +
      'This is the ONLY tool that ticks off plan steps — it takes no slug, because a plan has none. Call it ' +
      'as you go: "in_progress" when starting a step, "completed" as soon as it is done.',
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
        args,
        run() {
          const plan = ctx.plan.current
          if (!plan) throw new Error('No plan exists yet. Call write_plan first.')
          const step = plan.steps[args.stepNumber - 1]
          if (!step) {
            // List the real steps rather than just the count — a wrong number
            // is usually the model having lost the mapping, and it can only
            // retry correctly if it can see what the positions actually are.
            const numbered = plan.steps
              .map((planStep, index) => `${index + 1}. ${planStep.title}`)
              .join('\n')
            throw new Error(
              `No step ${args.stepNumber} in the current plan (it has ${plan.steps.length}). ` +
                `The steps are:\n${numbered}`
            )
          }
          step.status = args.status
          plan.updatedAt = Date.now()
          const completed = plan.steps.filter((planStep) => planStep.status === 'completed').length
          const nextPending = plan.steps.findIndex((planStep) => planStep.status === 'pending')
          const remaining =
            completed === plan.steps.length
              ? ' All steps are now complete.'
              : nextPending === -1
                ? ''
                : ` Next unstarted step is ${nextPending + 1} ("${plan.steps[nextPending].title}").`
          return Promise.resolve({
            modelResult:
              `Step ${args.stepNumber} ("${step.title}") marked ${args.status}. ` +
              `${completed}/${plan.steps.length} steps complete.${remaining}`,
            detail: step.title,
            plan
          })
        }
      })
  })

function isSamePlan(current: Plan, title: string, stepTitles: string[]): boolean {
  return (
    current.title === title &&
    current.steps.length === stepTitles.length &&
    current.steps.every(
      (step, index) => step.title === truncate(stepTitles[index], MAX_TITLE_CHARS)
    )
  )
}

function renderPlan(plan: Plan): string {
  return plan.steps.map((step, index) => `${index + 1}. [${step.status}] ${step.title}`).join('\n')
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
