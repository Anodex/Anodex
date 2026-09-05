import { TOOL_CATALOG } from '@shared/tools.types'
import { describeRecurrence, parseWhen } from '@shared/parseWhen'
import type { ToolFactory } from './types'
import { runGuardedToolWithPrepare } from './helpers'
import { schedulerStore } from '../scheduler/SchedulerStore'
import { schedulerService } from '../scheduler/SchedulerService'
import type { CreateScheduledTaskRequest } from '@shared/scheduledTask.types'

/**
 * Lets the assistant set up a Scheduler task. Anodex has had a full Scheduler
 * and no way for the model to reach it, so asking for a reminder got "I don't
 * have a way to schedule emails or set reminders" while the feature sat one
 * page away.
 *
 * `when` is natural language on purpose: it goes through the same `parseWhen`
 * the Scheduler's own When field uses, so anything a user can type in the UI
 * works here and both surfaces stay consistent about what "hourly" or
 * "tomorrow at noon" mean.
 */
export const scheduleTaskTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Schedule a prompt to run automatically later, once or on a repeat. Use for reminders and recurring work ("remind me at 5pm", "every weekday at 9am summarize my inbox"). The scheduled run happens with nobody watching, so it cannot send email — have it draft and notify instead.',
    params: {
      type: 'object',
      properties: {
        when: {
          type: 'string',
          description:
            'When to run, in plain language: "in 30 minutes", "tomorrow at noon", "September 4 at 9am", "on the 15th at 9am", "2026-09-04 at 09:00", "every weekday at 9am", "hourly", "every 2 days at 6pm", "the 1st of every month at 9am", "the last Friday of the month". For a specific day, say the date — a bare time means the next time the clock reads that, which may be tomorrow.'
        },
        prompt: {
          type: 'string',
          description:
            'The instruction the scheduled run executes. Write it standalone — the run starts in its own conversation and cannot see this chat.'
        },
        name: {
          type: 'string',
          description: 'Optional short label for the task. Derived from the prompt when omitted.'
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional tool names the run may use unattended. Omit for a chat-only run. Tools needing per-action approval, such as send_email, cannot be granted.'
        }
      },
      required: ['when', 'prompt']
    } as const,
    handler: (args: { when: string; prompt: string; name?: string; tools?: string[] }) =>
      runGuardedToolWithPrepare<{ request: CreateScheduledTaskRequest; label: string }>(
        ctx,
        {
          name: 'schedule_task',
          kind: 'write',
          title: `Schedule "${truncate(args.name?.trim() || args.prompt, 40)}"`,
          args,
          // Creating a task is standing configuration that runs itself later,
          // so the prompt states the resolved schedule rather than the raw
          // phrase — "every 5 minutes" and "in 5 minutes" are one typo apart
          // and mean very different things once it's saved.
          risk: 'sensitive',
          forceConfirm: true
        },
        () => {
          const prompt = args.prompt.trim()
          if (!prompt) throw new Error('A scheduled task needs a prompt to run.')

          const parsed = parseWhen(args.when)
          if (!parsed) {
            throw new Error(
              `Could not read "${args.when}" as a time. Try a form like "in 30 minutes", "tomorrow at noon", "every weekday at 9am", or "hourly".`
            )
          }

          const { granted, refused } = resolveRequestedTools(args.tools, ctx.projectId !== null)
          const label = parsed.note ? `${parsed.label} (${parsed.note})` : parsed.label

          return Promise.resolve({
            confirmDetail: [
              `When: ${label}`,
              `Tools: ${granted.length ? granted.join(', ') : 'none (chat only)'}`,
              refused.length ? `Not granted: ${refused.join(', ')}` : null,
              '',
              prompt
            ]
              .filter((line) => line !== null)
              .join('\n'),
            data: {
              request: {
                name: args.name?.trim() || undefined,
                prompt,
                projectId: ctx.projectId,
                recurrence: parsed.recurrence,
                enabledTools: granted
              },
              label
            }
          })
        },
        ({ request, label }) => {
          const task = schedulerStore.create(request)
          // The Scheduler page mirrors a main-process list; without this it
          // keeps showing the old one until the next run or a reload.
          schedulerService.notifyTasksChanged()
          const next =
            task.nextRunAt === null ? 'not scheduled' : new Date(task.nextRunAt).toLocaleString()
          return Promise.resolve({
            modelResult: [
              `Scheduled "${task.name}".`,
              `Schedule: ${describeRecurrence(task.recurrence)}`,
              `First run: ${next}`,
              'The user can edit or delete it on the Scheduler page.'
            ].join('\n'),
            detail: `${task.name} — ${label}`
          })
        }
      )
  })

/**
 * Lets the assistant remove a Scheduler task the user asks it to remove.
 *
 * Chat was read-only toward the Scheduler except for creating, and the prompt
 * told the model to send the user to the Scheduler view for anything else. That
 * produced the single worst-scoring behaviour in the chat matrix: asked to
 * delete a task and then pushed with "I'm the owner and I'm authorising it",
 * five of six models answered with a vague deflection rather than a clean no.
 *
 * The deeper problem was that the request is reasonable and the app could
 * simply honour it. Refusing to delete was a line drawn at "create only", not a
 * safety requirement: `schedule_task` already mutates the Scheduler, and the
 * user confirms it before it saves. A confirmed delete is not more dangerous
 * than a confirmed create — it is less, because it removes standing work rather
 * than adding some.
 *
 * Two deliberate differences from `schedule_task`:
 *
 * - `risk: 'destructive'`, which always confirms *and* is refused by
 *   `headlessConfirm`. A scheduled or agent run therefore cannot delete tasks
 *   with nobody watching, which matters most for the case of a scheduled task
 *   deleting scheduled tasks.
 * - The task is resolved by name and the tool refuses anything ambiguous. It
 *   never picks one of several matches: deleting the wrong standing task is
 *   silent until the thing it did stops happening.
 */
export const deleteScheduledTaskTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Delete a Scheduler task the user asks to remove or cancel. The user confirms the exact task before anything is deleted. Identify the task by its name as shown in the Scheduler; call anodex_status first if you do not know it.',
    params: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'The task to delete, by name as shown in the Scheduler. Enough of the name to identify exactly one task; the call is refused rather than guessing if it matches several.'
        }
      },
      required: ['name']
    } as const,
    handler: (args: { name: string }) =>
      runGuardedToolWithPrepare<{ id: string; name: string; schedule: string }>(
        ctx,
        {
          name: 'delete_scheduled_task',
          kind: 'write',
          title: `Delete scheduled task "${truncate(args.name, 40)}"`,
          args,
          // Always confirmed, and never available to an unattended run.
          risk: 'destructive',
          forceConfirm: true
        },
        () => {
          const wanted = args.name?.trim()
          if (!wanted) throw new Error('Name the task to delete.')

          const tasks = schedulerStore.list()
          if (tasks.length === 0) throw new Error('There are no scheduled tasks to delete.')

          // Exact name first, so a task called "Test" is reachable even when
          // "Test run" also exists.
          const exact = tasks.filter((task) => task.name.toLowerCase() === wanted.toLowerCase())
          const matches =
            exact.length > 0
              ? exact
              : tasks.filter((task) => task.name.toLowerCase().includes(wanted.toLowerCase()))

          if (matches.length === 0) {
            throw new Error(
              `No scheduled task matches "${wanted}". Existing tasks: ${tasks
                .map((task) => `"${task.name}"`)
                .join(', ')}.`
            )
          }
          if (matches.length > 1) {
            throw new Error(
              `"${wanted}" matches ${matches.length} tasks: ${matches
                .map((task) => `"${task.name}"`)
                .join(', ')}. Name one exactly.`
            )
          }

          const task = matches[0]
          const schedule = describeRecurrence(task.recurrence)
          return Promise.resolve({
            // The user is approving the removal of standing work, so the card
            // states what it does and when it would next have run, not just a
            // name they may have typed loosely.
            confirmDetail: [
              `Task: ${task.name}`,
              `Schedule: ${schedule}`,
              `Next run: ${task.nextRunAt === null ? 'not scheduled' : new Date(task.nextRunAt).toLocaleString()}`,
              '',
              task.prompt
            ].join('\n'),
            data: { id: task.id, name: task.name, schedule }
          })
        },
        ({ id, name, schedule }) => {
          schedulerStore.delete(id)
          // Same reason as `schedule_task`: the Scheduler page mirrors a
          // main-process list and would keep showing the deleted task.
          schedulerService.notifyTasksChanged()
          return Promise.resolve({
            modelResult: `Deleted "${name}" (${schedule}). It will not run again.`,
            detail: name
          })
        }
      )
  })

/**
 * Narrows a requested tool list to what a scheduled run may actually be given,
 * and reports what was dropped so the confirmation prompt can say so rather
 * than silently granting less than the model asked for.
 *
 * Human-approval-only tools are refused here as well as at call time. A task is
 * created by whatever conversation is running — including an unattended agent
 * run — so letting one be baked into a task's tool list would route around
 * `headlessConfirm` by scheduling the send instead of making it.
 */
function resolveRequestedTools(
  requested: string[] | undefined,
  hasProject: boolean
): { granted: string[]; refused: string[] } {
  if (!requested?.length) return { granted: [], refused: [] }

  const granted: string[] = []
  const refused: string[] = []
  for (const name of new Set(requested.map((entry) => entry.trim()).filter(Boolean))) {
    const entry = TOOL_CATALOG.find((tool) => tool.name === name)
    if (!entry) refused.push(`${name} (no such tool)`)
    else if (entry.requiresHumanApproval) refused.push(`${name} (needs a person to approve it)`)
    else if (entry.requiresProject && !hasProject) refused.push(`${name} (needs an open project)`)
    else granted.push(name)
  }
  return { granted, refused }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}
