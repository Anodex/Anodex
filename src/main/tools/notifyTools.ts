import type { ToolFactory } from './types'
import { runGuardedTool } from './helpers'
import { ownProcess } from './processTools'
import { noticeAfterReply } from '../notifications/replyNotices'
import type { ReminderChannel } from '@shared/scheduledTask.types'

const CHANNELS: readonly ReminderChannel[] = ['desktop', 'phone', 'email']

/**
 * notify_me_when_done — "tell me when the build is done", "let me know on my
 * phone when you've finished".
 *
 * Two things can be waited on: a background process (ready once it shows a
 * local address, or when it exits), and this reply itself, delivered when it
 * ends however it ends. The notice goes out exactly as a reminder does, with
 * the same fallback to the desktop when the phone is away or email fails.
 *
 * `trivial` risk: it only shows the person a message they asked for.
 */
export const notifyMeWhenDoneTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Tell the person when something finishes: this reply (when you are done with the whole request), or a background process started with start_process (when it is ready, or when it exits). The notice goes to this computer, their paired phone, and/or their own email, as they asked. Use it when they say "let me know when it\'s done".',
    params: {
      type: 'object',
      properties: {
        what: {
          enum: ['reply', 'process'],
          description:
            '"reply" to notify when this reply is finished; "process" to watch a background process.'
        },
        process_id: {
          type: 'string',
          description: 'For "process": the id start_process or list_processes gave.'
        },
        when: {
          enum: ['ready', 'exits'],
          description:
            'For "process": "ready" once it shows a local address or ends (a dev server), "exits" only when it ends (a build or install). Default "exits".'
        },
        message: {
          type: 'string',
          description: 'What the notice says, for the person: "The site build".'
        },
        via: {
          type: 'array',
          items: { enum: ['desktop', 'phone', 'email'] },
          description:
            'Where: "desktop", "phone", "email" (their own linked address). Use what the person said. Omit for desktop and phone.'
        }
      },
      required: ['what', 'message']
    } as const,
    handler: (args: {
      what: 'reply' | 'process'
      process_id?: string
      when?: 'ready' | 'exits'
      message: string
      via?: ReminderChannel[]
    }) =>
      runGuardedTool(ctx, {
        name: 'notify_me_when_done',
        kind: 'write',
        title: `Notify when done: ${truncate(args.message, 40)}`,
        args,
        confirmDetail: `Tell you when it is done: "${args.message}"`,
        risk: 'trivial',
        async run() {
          const message = args.message.trim() || 'Done'
          const via = (args.via ?? []).filter((channel) => CHANNELS.includes(channel))
          const notice = { message, ...(via.length ? { via } : {}) }

          if (args.what === 'process') {
            const id = args.process_id?.trim()
            if (!id) {
              return {
                modelResult: 'Give the process_id of the background process to watch.',
                madeProgress: false
              }
            }
            const when = args.when ?? 'exits'
            // Only this project's processes, as with every other process tool.
            // Read when needed: delivery reaches the toast window, email and the
            // phone service, which this tool file has no reason to load early.
            const { doneNotices } = await import('../notifications')
            const state = ownProcess(ctx.projectId, id)
              ? doneNotices.watchProcess(id, when, notice)
              : 'unknown'
            if (state === 'unknown') {
              return {
                modelResult: `No background process "${id}" for this project. list_processes shows the ones there are.`,
                madeProgress: false
              }
            }
            return {
              modelResult:
                state === 'now'
                  ? 'It had already finished, so the notice was sent now.'
                  : `Watching it. The person is told when it ${when === 'ready' ? 'is ready' : 'exits'}.`,
              madeProgress: true
            }
          }

          noticeAfterReply(ctx.messageId, notice)
          return {
            modelResult:
              'The person is told when this reply finishes. Carry on with the request; there is nothing else to do for the notice.',
            madeProgress: true
          }
        }
      })
  })

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}
