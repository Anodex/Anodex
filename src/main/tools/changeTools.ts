import type { WorkspaceToolContext, WorkspaceToolFactory } from './types'
import { runGuardedTool, runReadTool } from './helpers'
import { changeStore } from '../changes/ChangeStore'

/**
 * Changes and plans are two different things that both hold an ordered task
 * list, and models — local ones especially — routinely confuse them: after
 * `write_plan({ title: 'Solar System Website', ... })` they'll try to tick a
 * step off with `update_change_task({ slug: 'solar-system-website', ... })`,
 * hit "No change named ...", and then quietly give up on updating the plan at
 * all, leaving the user's Plan panel stuck at 0/6.
 *
 * So when a change tool is handed a slug that doesn't exist while a plan IS
 * active, say so and name the tool that actually does what they meant. The
 * check runs before the store so the redirect wins over the generic error.
 */
function assertNotAPlanStepMixup(ctx: WorkspaceToolContext, slug: string): void {
  const plan = ctx.plan.current
  if (!plan) return
  if (changeStore.get(ctx.workspaceRoot, slug)) return
  throw new Error(
    `No change named "${slug}" exists. This conversation has an active PLAN titled "${plan.title}" ` +
      '— plans are not changes and have no slug. To tick off a plan step use ' +
      'update_plan_step({ stepNumber, status }) instead. Use list_changes to see real changes.'
  )
}

/**
 * propose_change — create a new persisted change proposal (why + a task
 * checklist), stored at `.anodex/changes/<slug>/proposal.md` so it survives
 * this conversation. Goes through `runGuardedTool` like any write tool, so it
 * automatically gets the full/untethered-mode turn gate and batch-review UI
 * for free — no separate wiring needed.
 */
export const proposeChangeTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Propose a new change for this project: a short rationale plus a task checklist, persisted to ' +
      '.anodex/changes/<slug>/proposal.md so it survives this conversation and can be tracked across ' +
      'sessions. Use this for a non-trivial, multi-step change — skip it for a single quick edit.',
    params: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the change.' },
        why: {
          type: 'string',
          description: 'A short paragraph explaining why this change is needed.'
        },
        tasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered list of concrete task titles.'
        }
      },
      required: ['title', 'why', 'tasks']
    } as const,
    handler: (args: { title: string; why: string; tasks: string[] }) =>
      runGuardedTool(ctx, {
        name: 'propose_change',
        kind: 'write',
        title: `Propose change: ${args.title}`,
        args,
        risk: 'safe',
        confirmDetail: `${args.title}\n\n${args.why}\n\nTasks:\n${args.tasks.map((task) => `- ${task}`).join('\n')}`,
        run() {
          const change = changeStore.create(ctx.workspaceRoot, args.title, args.why, args.tasks)
          return Promise.resolve({
            modelResult: `Created change "${change.slug}" with ${change.tasks.length} task(s).`,
            detail: change.slug
          })
        }
      })
  })

/** update_change_task — mark a change's task done/not done, persisted to its proposal.md. */
export const updateChangeTaskTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Mark a task of an existing persisted change as done or not done. Refer to the change by the slug ' +
      'returned by propose_change or list_changes, and the task by its 1-based position. This is only for ' +
      'changes created with propose_change — it is NOT the tool for the write_plan task plan shown in the ' +
      'Workspace Dock; use update_plan_step for that.',
    params: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'The change slug, from propose_change or list_changes.'
        },
        taskNumber: { type: 'number', description: '1-based position of the task.' },
        done: { type: 'boolean', description: 'Whether the task is now done.' }
      },
      required: ['slug', 'taskNumber', 'done']
    } as const,
    handler: (args: { slug: string; taskNumber: number; done: boolean }) =>
      runGuardedTool(ctx, {
        name: 'update_change_task',
        kind: 'write',
        title: `Update ${args.slug} task ${args.taskNumber}`,
        args,
        risk: 'safe',
        confirmDetail: `Mark task ${args.taskNumber} of "${args.slug}" as ${args.done ? 'done' : 'not done'}.`,
        run() {
          assertNotAPlanStepMixup(ctx, args.slug)
          const change = changeStore.updateTask(
            ctx.workspaceRoot,
            args.slug,
            args.taskNumber - 1,
            args.done
          )
          const doneCount = change.tasks.filter((task) => task.done).length
          return Promise.resolve({
            modelResult: `Task ${args.taskNumber} of "${args.slug}" marked ${args.done ? 'done' : 'not done'}. Change status: ${change.status}.`,
            detail: `${doneCount}/${change.tasks.length} done`
          })
        }
      })
  })

/**
 * archive_change — fold a finished change into the project's living spec
 * (`.anodex/SPEC.md`) and move it out of the active change list.
 */
export const archiveChangeTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      "Archive a finished change: folds it into this project's living spec (.anodex/SPEC.md) and " +
      'moves it out of the active change list.',
    params: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'The change slug to archive.' }
      },
      required: ['slug']
    } as const,
    handler: (args: { slug: string }) =>
      runGuardedTool(ctx, {
        name: 'archive_change',
        kind: 'write',
        title: `Archive change: ${args.slug}`,
        args,
        risk: 'safe',
        confirmDetail: `Archive "${args.slug}" and add it to this project's living spec.`,
        run() {
          assertNotAPlanStepMixup(ctx, args.slug)
          changeStore.archive(ctx.workspaceRoot, args.slug)
          return Promise.resolve({
            modelResult: `Archived "${args.slug}" and added it to .anodex/SPEC.md.`,
            detail: 'Archived'
          })
        }
      })
  })

/** list_changes — read-only list of a project's active change proposals. */
export const listChangesTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description: "List this project's active (non-archived) change proposals.",
    params: { type: 'object', properties: {} } as const,
    handler: () =>
      runReadTool(ctx, {
        name: 'list_changes',
        kind: 'read',
        title: 'List changes',
        run() {
          const changes = changeStore.list(ctx.workspaceRoot)
          if (changes.length === 0) {
            return Promise.resolve({
              modelResult: 'No active changes proposed yet.',
              detail: '0 changes'
            })
          }
          const lines = changes.map((change) => {
            const doneCount = change.tasks.filter((task) => task.done).length
            return `${change.slug} [${change.status}] — ${change.title} (${doneCount}/${change.tasks.length} tasks)`
          })
          return Promise.resolve({
            modelResult: lines.join('\n'),
            detail: `${changes.length} changes`
          })
        }
      })
  })
