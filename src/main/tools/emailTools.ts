import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EmailDraft, EmailDraftRequest, EmailThreadSummary } from '@shared/email.types'
import type { ToolFactory, WorkspaceToolFactory } from './types'
import { runGuardedTool, runGuardedToolWithPrepare, runReadTool } from './helpers'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import { emailService } from '../email/EmailService'
import { encodeCheckpointBuffer } from '../checkpoints/contentEncoding'

const MAX_BODY_PREVIEW = 700

export const listEmailThreadsTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'List recent email threads from the connected Gmail account. Returns subject, sender, snippet, unread state, and attachment count.',
    params: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Optional maximum number of threads to return, up to 20.'
        }
      }
    } as const,
    handler: (args: { limit?: number }) =>
      runReadTool(ctx, {
        name: 'list_threads',
        kind: 'read',
        title: 'List email threads',
        args,
        async run() {
          const threads = await emailService.listThreads({ limit: args.limit })
          return formatThreads(threads)
        }
      })
  })

export const searchEmailTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Search Gmail threads by query. Use this when the user asks about email matching people, subjects, dates, or keywords.',
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The Gmail search query.' },
        limit: { type: 'number', description: 'Optional maximum number of results, up to 20.' }
      },
      required: ['query']
    } as const,
    handler: (args: { query: string; limit?: number }) =>
      runReadTool(ctx, {
        name: 'search_email',
        kind: 'read',
        title: `Search email "${truncate(args.query, 40)}"`,
        args,
        async run() {
          const threads = await emailService.search({ query: args.query, limit: args.limit })
          return formatThreads(threads)
        }
      })
  })

export const readEmailTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Read one Gmail message by id, including body text and attachment metadata when available.',
    params: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'The latest message id returned by search_email or list_threads.'
        }
      },
      required: ['messageId']
    } as const,
    handler: (args: { messageId: string }) =>
      runReadTool(ctx, {
        name: 'read_email',
        kind: 'read',
        title: `Read email ${truncate(args.messageId, 24)}`,
        args,
        async run() {
          const message = await emailService.readMessage(args.messageId)
          return {
            modelResult: [
              `Subject: ${message.subject}`,
              `From: ${message.from}`,
              `To: ${message.to.join(', ')}`,
              `Date: ${new Date(message.date).toISOString()}`,
              '',
              message.body,
              '',
              `Attachments: ${message.attachments.length}`,
              ...message.attachments.map(
                (attachment) =>
                  `- ${attachment.filename} (messageId: ${attachment.messageId}; attachmentId: ${attachment.id}; ${attachment.mimeType}; ${attachment.size} bytes)`
              )
            ].join('\n'),
            detail: message.subject
          }
        }
      })
  })

export const summarizeEmailThreadTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Summarize a Gmail thread by id. Use after search_email or list_threads when the user wants the gist of a conversation.',
    params: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description: 'The thread id returned by search_email or list_threads.'
        }
      },
      required: ['threadId']
    } as const,
    handler: (args: { threadId: string }) =>
      runReadTool(ctx, {
        name: 'summarize_thread',
        kind: 'read',
        title: `Summarize email thread ${truncate(args.threadId, 24)}`,
        args,
        async run() {
          const summary = await emailService.summarizeThread(args.threadId)
          return { modelResult: summary, detail: truncate(summary, 80) }
        }
      })
  })

export const findEmailAttachmentsTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Find attachments in a Gmail thread by id and return filenames, MIME types, and sizes.',
    params: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description: 'The thread id returned by search_email or list_threads.'
        }
      },
      required: ['threadId']
    } as const,
    handler: (args: { threadId: string }) =>
      runReadTool(ctx, {
        name: 'find_attachments',
        kind: 'read',
        title: `Find email attachments ${truncate(args.threadId, 24)}`,
        args,
        async run() {
          const attachments = await emailService.listAttachments(args.threadId)
          if (attachments.length === 0) {
            return {
              modelResult: 'No attachments found.',
              detail: '0 attachments'
            }
          }
          return {
            modelResult: attachments
              .map(
                (attachment, index) =>
                  `${index + 1}. ${attachment.filename} (messageId: ${attachment.messageId}; attachmentId: ${attachment.id}; ${attachment.mimeType}; ${attachment.size} bytes)`
              )
              .join('\n'),
            detail: `${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`
          }
        }
      })
  })

export const draftEmailTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Create a local email draft from recipients, subject, and body. This does not send email.',
    params: {
      type: 'object',
      properties: {
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Recipient email addresses.'
        },
        cc: { type: 'array', items: { type: 'string' }, description: 'Optional CC recipients.' },
        bcc: { type: 'array', items: { type: 'string' }, description: 'Optional BCC recipients.' },
        subject: { type: 'string', description: 'Draft subject.' },
        body: { type: 'string', description: 'Draft body.' }
      },
      required: ['to', 'subject', 'body']
    } as const,
    handler: (args: EmailDraftRequest) =>
      runReadTool(ctx, {
        name: 'draft_email',
        kind: 'read',
        title: `Draft email to ${args.to.join(', ')}`,
        args,
        run() {
          return Promise.resolve(formatDraft(emailService.createDraft(args)))
        }
      })
  })

export const sendEmailTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Send an email through Gmail. This always requires explicit user approval before sending.',
    params: {
      type: 'object',
      properties: {
        draftId: {
          type: 'string',
          description:
            'Optional draft id returned by draft_email. When provided, the saved draft content is sent.'
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Recipient email addresses.'
        },
        cc: { type: 'array', items: { type: 'string' }, description: 'Optional CC recipients.' },
        bcc: { type: 'array', items: { type: 'string' }, description: 'Optional BCC recipients.' },
        subject: { type: 'string', description: 'Email subject.' },
        body: { type: 'string', description: 'Email body.' }
      },
      required: ['to', 'subject', 'body']
    } as const,
    handler: (args: EmailDraftRequest & { draftId?: string }) =>
      runGuardedToolWithPrepare(
        ctx,
        {
          name: 'send_email',
          kind: 'write',
          title: `Send email to ${args.to.join(', ')}`,
          args,
          risk: 'sensitive',
          forceConfirm: true
        },
        // Resolve *before* the user sees the confirm prompt: when draftId is
        // set, `EmailService.send` below sends the saved draft's content and
        // silently ignores whatever to/subject/body the model passed
        // alongside it (the schema requires them regardless). Confirming
        // against those raw args instead of the draft would let the user
        // approve one email while a different one gets sent.
        () => {
          const message = resolveEmailToSend(args)
          return Promise.resolve({ confirmDetail: describeEmailToSend(message), data: message })
        },
        async (message) => {
          await emailService.send(args)
          return { modelResult: 'Email sent.', detail: message.subject }
        }
      )
  })

function resolveEmailToSend(args: EmailDraftRequest & { draftId?: string }): EmailDraftRequest {
  if (!args.draftId) return args
  const draft = emailService.getDraft(args.draftId)
  if (!draft) throw new Error(`Email draft not found: ${args.draftId}`)
  return draft
}

function describeEmailToSend(message: EmailDraftRequest): string {
  return [
    `To: ${message.to.join(', ')}`,
    message.cc?.length ? `Cc: ${message.cc.join(', ')}` : null,
    message.bcc?.length ? `Bcc: ${message.bcc.join(', ')}` : null,
    `Subject: ${message.subject}`,
    '',
    truncate(message.body, MAX_BODY_PREVIEW)
  ]
    .filter(Boolean)
    .join('\n')
}

export const saveEmailAttachmentTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Save a Gmail attachment into the current workspace. Use after find_attachments/read_email when the user wants an attachment available as a project file.',
    params: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'The Gmail message id containing the attachment.'
        },
        attachmentId: {
          type: 'string',
          description: 'The attachment id returned by read_email/find_attachments.'
        },
        path: {
          type: 'string',
          description: 'Destination file path relative to the workspace root.'
        }
      },
      required: ['messageId', 'attachmentId', 'path']
    } as const,
    handler: (args: { messageId: string; attachmentId: string; path: string }) =>
      runGuardedTool(ctx, {
        name: 'save_email_attachment',
        kind: 'write',
        title: `Save email attachment to ${args.path}`,
        args,
        confirmDetail: `Save attachment ${args.attachmentId} from message ${args.messageId} to ${args.path}`,
        risk: 'safe',
        touch: { path: args.path, action: 'write' },
        async run() {
          const destination = resolveInWorkspace(ctx.workspaceRoot, args.path)
          const beforeExists = await access(destination)
            .then(() => true)
            .catch(() => false)
          const before = beforeExists ? encodeCheckpointBuffer(await readFile(destination)) : null
          const attachment = await emailService.getAttachment(args.messageId, args.attachmentId)
          const after = encodeCheckpointBuffer(attachment.data)
          await mkdir(dirname(destination), { recursive: true })
          await writeFile(destination, attachment.data)
          const relativePath = toWorkspaceRelative(ctx.workspaceRoot, destination)
          return {
            modelResult: `Saved attachment ${attachment.filename} (${attachment.mimeType}, ${attachment.data.length} bytes) to ${relativePath}.`,
            detail: `${attachment.filename} → ${relativePath}`,
            checkpointChanges: [
              {
                path: relativePath,
                before: before?.data ?? null,
                after: after.data,
                beforeEncoding: before?.encoding,
                afterEncoding: after.encoding
              }
            ]
          }
        }
      })
  })

function formatThreads(threads: EmailThreadSummary[]): { modelResult: string; detail: string } {
  if (threads.length === 0) {
    return { modelResult: 'No email threads found.', detail: '0 threads' }
  }

  return {
    modelResult: threads
      .map(
        (thread, index) =>
          `${index + 1}. [threadId: ${thread.id}; latestMessageId: ${thread.latestMessageId}] ${thread.subject}\nFrom: ${thread.from}\nUpdated: ${new Date(
            thread.updatedAt
          ).toISOString()}\n${thread.snippet}\nMessages: ${thread.messageCount}; Attachments: ${
            thread.attachmentCount
          }; ${thread.unread ? 'Unread' : 'Read'}`
      )
      .join('\n\n'),
    detail: `${threads.length} thread${threads.length === 1 ? '' : 's'}`
  }
}

function formatDraft(draft: EmailDraft): { modelResult: string; detail: string } {
  return {
    modelResult: [
      `Draft id: ${draft.id}`,
      `To: ${draft.to.join(', ')}`,
      draft.cc.length ? `Cc: ${draft.cc.join(', ')}` : null,
      draft.bcc.length ? `Bcc: ${draft.bcc.join(', ')}` : null,
      `Subject: ${draft.subject}`,
      '',
      draft.body
    ]
      .filter(Boolean)
      .join('\n'),
    detail: draft.subject
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}
