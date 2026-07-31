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
            'When to run, in plain language: "in 30 minutes", "tomorrow at noon", "every weekday at 9am", "hourly", "every 2 days at 6pm".'
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
