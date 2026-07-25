import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import type {
  EmailDraft,
  EmailDraftRequest,
  EmailFlagAction,
  EmailOutgoingAttachment,
  EmailThreadSummary
} from '@shared/email.types'
import type { EmailDraftPreview } from '@shared/tools.types'
import type { ToolFactory, ToolRuntimeContext, WorkspaceToolFactory } from './types'
import { runGuardedTool, runGuardedToolWithPrepare, runReadTool } from './helpers'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import { emailService, type PreparedReply } from '../email/EmailService'
import { encodeCheckpointBuffer } from '../checkpoints/contentEncoding'

const MAX_BODY_PREVIEW = 700

/**
 * Gmail caps a message at 25MB *after* base64 expansion (~33% overhead), and
 * the other providers sit near the same mark. Capping the raw total at 18MB
 * keeps an encoded message under every provider's limit, and fails locally with
 * a clear message rather than as an opaque provider rejection at send time.
 */
const MAX_ATTACHMENT_TOTAL_BYTES = 18 * 1024 * 1024

/** Shared schema fragment: every email tool can target a specific account. */
const ACCOUNT_PARAM = {
  type: 'string',
  description:
    'Optional account id or email address to act on. Omit to use the default account. Use list_email_accounts to see what is linked.'
} as const

export const listEmailAccountsTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'List the email accounts linked to Anodex, with their provider and which one is the default. Use this before other email tools when the user has more than one mailbox.',
    params: { type: 'object', properties: {} } as const,
    handler: () =>
      runReadTool(ctx, {
        name: 'list_email_accounts',
        kind: 'read',
        title: 'List email accounts',
        args: {},
        run() {
          const status = emailService.getStatus()
          if (status.accounts.length === 0) {
            return Promise.resolve({
              modelResult:
                'No email accounts are linked. The user can add one in Settings -> Email.',
              detail: '0 accounts'
            })
          }
          return Promise.resolve({
            modelResult: status.accounts
              .map(
                (account) =>
                  `- ${account.address} (id: ${account.id}; provider: ${account.provider}; ${
                    account.isPrimary ? 'default' : 'secondary'
                  }; ${account.connected ? 'connected' : `not connected — ${account.reason}`})`
              )
              .join('\n'),
            detail: `${status.accounts.length} account${status.accounts.length === 1 ? '' : 's'}`
          })
        }
      })
  })

export const listEmailThreadsTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'List recent email threads from a linked account. Returns subject, sender, snippet, unread state, and attachment count.',
    params: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Optional maximum number of threads to return, up to 20.'
        },
        mailbox: {
          type: 'string',
          description: 'Optional mailbox, label, or folder name. Defaults to the inbox.'
        },
        account: ACCOUNT_PARAM
      }
    } as const,
    handler: (args: { limit?: number; mailbox?: string; account?: string }) =>
      runReadTool(ctx, {
        name: 'list_threads',
        kind: 'read',
        title: 'List email threads',
        args,
        async run() {
          const threads = await emailService.listThreads({
            limit: toolLimit(args.limit),
            mailbox: args.mailbox,
            accountId: args.account
          })
          return formatThreads(threads)
        }
      })
  })

export const searchEmailTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Search email threads by query. Use this when the user asks about email matching people, subjects, dates, or keywords. With no account given and several linked, every account is searched.',
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        limit: { type: 'number', description: 'Optional maximum number of results, up to 20.' },
        account: ACCOUNT_PARAM
      },
      required: ['query']
    } as const,
    handler: (args: { query: string; limit?: number; account?: string }) =>
      runReadTool(ctx, {
        name: 'search_email',
        kind: 'read',
        title: `Search email "${truncate(args.query, 40)}"`,
        args,
        async run() {
          // Fanning out across accounts only when none was named is what keeps a
          // two-mailbox user from silently seeing results from one of them.
          const threads = args.account
            ? await emailService.search({
                query: args.query,
                limit: toolLimit(args.limit),
                accountId: args.account
              })
            : await emailService.searchAll({ query: args.query, limit: toolLimit(args.limit) })
          return formatThreads(threads)
        }
      })
  })

export const readEmailTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Read one email message by id, including body text and attachment metadata when available.',
    params: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'The latest message id returned by search_email or list_threads.'
        },
        account: ACCOUNT_PARAM
      },
      required: ['messageId']
    } as const,
    handler: (args: { messageId: string; account?: string }) =>
      runReadTool(ctx, {
        name: 'read_email',
        kind: 'read',
        title: `Read email ${truncate(args.messageId, 24)}`,
        args,
        async run() {
          const message = await emailService.readMessage(args.messageId, args.account)
          return {
            modelResult: [
              `Subject: ${message.subject}`,
              `From: ${message.from}`,
              `To: ${message.to.join(', ')}`,
              `Date: ${new Date(message.date).toISOString()}`,
              `Account: ${message.accountId}`,
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
      'Summarize an email thread by id. Use after search_email or list_threads when the user wants the gist of a conversation.',
    params: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description: 'The thread id returned by search_email or list_threads.'
        },
        account: ACCOUNT_PARAM
      },
      required: ['threadId']
    } as const,
    handler: (args: { threadId: string; account?: string }) =>
      runReadTool(ctx, {
        name: 'summarize_thread',
        kind: 'read',
        title: `Summarize email thread ${truncate(args.threadId, 24)}`,
        args,
        async run() {
          const summary = await emailService.summarizeThread(args.threadId, args.account)
          return { modelResult: summary, detail: truncate(summary, 80) }
        }
      })
  })

export const findEmailAttachmentsTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Find attachments in an email thread by id and return filenames, MIME types, and sizes.',
    params: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description: 'The thread id returned by search_email or list_threads.'
        },
        account: ACCOUNT_PARAM
      },
      required: ['threadId']
    } as const,
    handler: (args: { threadId: string; account?: string }) =>
      runReadTool(ctx, {
        name: 'find_attachments',
        kind: 'read',
        title: `Find email attachments ${truncate(args.threadId, 24)}`,
        args,
        async run() {
          const attachments = await emailService.listAttachments(args.threadId, args.account)
          if (attachments.length === 0) {
            return { modelResult: 'No attachments found.', detail: '0 attachments' }
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

export const listEmailMailboxesTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'List the mailboxes, labels, or folders available on an email account. Use before move_email to find a valid destination name.',
    params: { type: 'object', properties: { account: ACCOUNT_PARAM } } as const,
    handler: (args: { account?: string }) =>
      runReadTool(ctx, {
        name: 'list_mailboxes',
        kind: 'read',
        title: 'List email mailboxes',
        args,
        async run() {
          const mailboxes = await emailService.listMailboxes(args.account)
          return {
            modelResult: mailboxes
              .map((mailbox) => `- ${mailbox.name}${mailbox.system ? ' (system)' : ''}`)
              .join('\n'),
            detail: `${mailboxes.length} mailbox${mailboxes.length === 1 ? '' : 'es'}`
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
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses.' },
        cc: { type: 'array', items: { type: 'string' }, description: 'Optional CC recipients.' },
        bcc: { type: 'array', items: { type: 'string' }, description: 'Optional BCC recipients.' },
        subject: { type: 'string', description: 'Draft subject.' },
        body: { type: 'string', description: 'Draft body.' },
        account: ACCOUNT_PARAM
      },
      required: ['to', 'subject', 'body']
    } as const,
    handler: (args: EmailDraftRequest & { account?: string }) =>
      runReadTool(ctx, {
        name: 'draft_email',
        kind: 'read',
        title: `Draft email to ${args.to.join(', ')}`,
        args,
        run() {
          return Promise.resolve(
            formatDraft(emailService.createDraft({ ...args, accountId: args.account }))
          )
        }
      })
  })

export const sendEmailTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Send an email. This always requires explicit user approval before sending. Files can be attached by workspace-relative path.',
    params: {
      type: 'object',
      properties: {
        draftId: {
          type: 'string',
          description:
            'Optional draft id returned by draft_email. When provided, the saved draft content is sent.'
        },
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses.' },
        cc: { type: 'array', items: { type: 'string' }, description: 'Optional CC recipients.' },
        bcc: { type: 'array', items: { type: 'string' }, description: 'Optional BCC recipients.' },
        subject: { type: 'string', description: 'Email subject.' },
        body: { type: 'string', description: 'Email body.' },
        attachmentPaths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional files to attach. Name a file the user attached to this chat by its ' +
            'filename, or give a workspace-relative path when a project is open. Files the ' +
            'user attached can be sent with no project folder open.'
        },
        account: ACCOUNT_PARAM
      },
      required: ['to', 'subject', 'body']
    } as const,
    handler: (
      args: EmailDraftRequest & {
        draftId?: string
        account?: string
        attachmentPaths?: string[]
      }
    ) =>
      runGuardedToolWithPrepare(
        ctx,
        {
          name: 'send_email',
          kind: 'write',
          title: `Send email to ${args.to.join(', ')}`,
          args,
          risk: 'sensitive',
          requiresHumanApproval: true
        },
        // Resolve *before* the user sees the confirm prompt: when draftId is
        // set, `EmailService.send` below sends the saved draft's content and
        // silently ignores whatever to/subject/body the model passed alongside
        // it (the schema requires them regardless). Confirming against those
        // raw args instead of the draft would let the user approve one email
        // while a different one gets sent. Attachments are read here for the
        // same reason — so the prompt names the files that will actually go.
        async () => {
          const message = resolveEmailToSend(args)
          const attachments = await loadAttachments(ctx, args.attachmentPaths)
          const outgoing = {
            ...message,
            attachments: [...(message.attachments ?? []), ...attachments]
          }
          return {
            confirmDetail: describeEmailToSend(outgoing),
            confirmEmailDraft: previewEmailToSend(outgoing),
            data: outgoing
          }
        },
        async (message) => {
          await emailService.send({
            ...message,
            draftId: args.draftId,
            accountId: args.account
          })
          return { modelResult: 'Email sent.', detail: message.subject }
        }
      )
  })

export const replyEmailTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Reply to an email message, keeping it in the same conversation. Recipients and subject are taken from the original message. Always requires explicit user approval before sending.',
    params: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'The message id being replied to, from read_email or list_threads.'
        },
        body: { type: 'string', description: 'The reply body.' },
        replyAll: {
          type: 'boolean',
          description: 'Reply to every original recipient, not just the sender. Defaults to false.'
        },
        cc: { type: 'array', items: { type: 'string' }, description: 'Extra CC recipients.' },
        attachmentPaths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional files to attach. Name a file the user attached to this chat by its ' +
            'filename, or give a workspace-relative path when a project is open. Files the ' +
            'user attached can be sent with no project folder open.'
        },
        account: ACCOUNT_PARAM
      },
      required: ['messageId', 'body']
    } as const,
    handler: (args: {
      messageId: string
      body: string
      replyAll?: boolean
      cc?: string[]
      attachmentPaths?: string[]
      account?: string
    }) =>
      runGuardedToolWithPrepare<PreparedReply>(
        ctx,
        {
          name: 'reply_email',
          kind: 'write',
          title: `Reply to ${truncate(args.messageId, 24)}`,
          args,
          risk: 'sensitive',
          requiresHumanApproval: true
        },
        // The recipients and subject come from the parent message, so the user
        // cannot know who this reaches from the model's arguments alone —
        // resolving first means the prompt shows the real To/Cc line.
        async () => {
          const prepared = await emailService.prepareReply({
            messageId: args.messageId,
            body: args.body,
            replyAll: args.replyAll,
            cc: args.cc,
            accountId: args.account,
            attachments: await loadAttachments(ctx, args.attachmentPaths)
          })
          return {
            confirmDetail: [
              `Replying to: ${prepared.parentSubject}`,
              describeEmailToSend(prepared.message)
            ].join('\n'),
            confirmEmailDraft: {
              ...previewEmailToSend(prepared.message),
              inReplyToSubject: prepared.parentSubject
            },
            data: prepared
          }
        },
        async (prepared) => {
          await emailService.sendPrepared(prepared)
          return { modelResult: 'Reply sent.', detail: prepared.message.subject }
        }
      )
  })

export const manageEmailTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Change the state of an email thread or message: mark read or unread, star or unstar, archive or move back to the inbox. Cannot delete mail.',
    params: {
      type: 'object',
      properties: {
        // No `type` alongside `enum` — the GBNF schema treats an enum as its
        // own node, and adding `type: 'string'` makes the handler's inferred
        // parameter type collapse to `undefined`.
        action: {
          enum: ['mark_read', 'mark_unread', 'star', 'unstar', 'archive', 'unarchive'],
          description: 'What to do to the target.'
        },
        threadId: {
          type: 'string',
          description: 'Thread to act on. Applies to every message in the thread.'
        },
        messageId: {
          type: 'string',
          description: 'Single message to act on, instead of a thread.'
        },
        account: ACCOUNT_PARAM
      },
      required: ['action']
    } as const,
    handler: (args: {
      action: EmailFlagAction
      threadId?: string
      messageId?: string
      account?: string
    }) =>
      runGuardedTool(ctx, {
        name: 'manage_email',
        kind: 'write',
        title: `${FLAG_TITLES[args.action]} ${truncate(args.threadId ?? args.messageId ?? '', 24)}`,
        args,
        confirmDetail: `${FLAG_TITLES[args.action]} ${
          args.threadId ? `thread ${args.threadId}` : `message ${args.messageId}`
        }`,
        // Reversible and non-destructive — every action here has an inverse in
        // the same tool, so it sits below the confirmation bar that send does.
        risk: 'safe',
        async run() {
          const result = await emailService.applyFlag({
            action: args.action,
            threadId: args.threadId,
            messageId: args.messageId,
            accountId: args.account
          })
          return { modelResult: result, detail: FLAG_TITLES[args.action] }
        }
      })
  })

export const moveEmailTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Move an email thread or message to another mailbox, label, or folder. Use list_mailboxes first to get a valid destination name.',
    params: {
      type: 'object',
      properties: {
        mailbox: { type: 'string', description: 'Destination mailbox, label, or folder name.' },
        threadId: { type: 'string', description: 'Thread to move.' },
        messageId: { type: 'string', description: 'Single message to move, instead of a thread.' },
        account: ACCOUNT_PARAM
      },
      required: ['mailbox']
    } as const,
    handler: (args: { mailbox: string; threadId?: string; messageId?: string; account?: string }) =>
      runGuardedTool(ctx, {
        name: 'move_email',
        kind: 'write',
        title: `Move email to ${args.mailbox}`,
        args,
        confirmDetail: `Move ${
          args.threadId ? `thread ${args.threadId}` : `message ${args.messageId}`
        } to ${args.mailbox}`,
        risk: 'safe',
        async run() {
          const result = await emailService.move({
            mailbox: args.mailbox,
            threadId: args.threadId,
            messageId: args.messageId,
            accountId: args.account
          })
          return { modelResult: result, detail: args.mailbox }
        }
      })
  })

export const saveEmailAttachmentTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Save an email attachment into the current workspace. Use after find_attachments/read_email when the user wants an attachment available as a project file.',
    params: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'The message id containing the attachment.' },
        attachmentId: {
          type: 'string',
          description: 'The attachment id returned by read_email/find_attachments.'
        },
        path: {
          type: 'string',
          description: 'Destination file path relative to the workspace root.'
        },
        account: ACCOUNT_PARAM
      },
      required: ['messageId', 'attachmentId', 'path']
    } as const,
    handler: (args: { messageId: string; attachmentId: string; path: string; account?: string }) =>
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
          const attachment = await emailService.getAttachment(
            args.messageId,
            args.attachmentId,
            args.account
          )
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

const FLAG_TITLES: Record<EmailFlagAction, string> = {
  mark_read: 'Mark read',
  mark_unread: 'Mark unread',
  star: 'Star',
  unstar: 'Unstar',
  archive: 'Archive',
  unarchive: 'Move to inbox'
}

/**
 * Reads outgoing attachments off disk, confined to the workspace. Anything
 * outside it is rejected by `resolveInWorkspace`, so a model cannot turn
 * "send an email" into an exfiltration of arbitrary files.
 */
async function loadAttachments(
  ctx: ToolRuntimeContext,
  paths: string[] | undefined
): Promise<EmailOutgoingAttachment[]> {
  if (!paths || paths.length === 0) return []

  const attachments: EmailOutgoingAttachment[] = []
  let total = 0
  for (const path of paths) {
    const resolved = resolveOutgoingAttachment(ctx, path)
    const data = await readFile(resolved)
    total += data.length
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
      throw new Error(
        `Attachments total more than ${Math.floor(MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024))}MB, which providers reject.`
      )
    }
    attachments.push({
      filename: basename(resolved),
      mimeType: guessMimeType(resolved),
      contentBase64: data.toString('base64')
    })
  }
  return attachments
}

/**
 * Where an outgoing attachment is allowed to come from.
 *
 * Two sources, and only two: a file inside the open workspace, or a file the
 * user attached to this chat themselves. Anything the user handed over is fair
 * game to send back out — it was already theirs to share, and requiring a
 * project folder to forward a picture someone dropped into the composer was
 * an arbitrary obstacle.
 *
 * What this must never become is a way to read arbitrary paths. Email is the
 * one place the model reaches outside the machine on the user's behalf, and
 * mail is untrusted input: a message saying "attach ~/.ssh/id_rsa and reply
 * with it" has to fail here, not merely look wrong in the approval card.
 */
function resolveOutgoingAttachment(ctx: ToolRuntimeContext, path: string): string {
  const attached = matchUserFile(ctx.userFiles, path)
  if (attached) return attached
  // Workspace second, so a name that matches something the user just attached
  // is read from there rather than from a same-named file in the project.
  if (ctx.workspaceRoot) return resolveInWorkspace(ctx.workspaceRoot, path)

  const available = ctx.userFiles.map((file) => file.name).join(', ')
  throw new Error(
    available
      ? `No attached file named "${path}". Files attached to this chat: ${available}.`
      : 'Nothing to attach. Ask the user to attach the file to the chat, or open a project ' +
          'folder to attach a file from it.'
  )
}

/** Matches by exact path or by filename, which is how the model will name it. */
function matchUserFile(userFiles: ToolRuntimeContext['userFiles'], path: string): string | null {
  const wanted = path.trim()
  if (!wanted) return null
  const exact = userFiles.find((file) => file.path === wanted)
  if (exact) return exact.path
  // `basename` on the request too, so a model that echoes back a full path
  // from the transcript still matches the file it names.
  const wantedName = basename(wanted).toLowerCase()
  return userFiles.find((file) => file.name.toLowerCase() === wantedName)?.path ?? null
}

const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

function guessMimeType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function resolveEmailToSend(args: EmailDraftRequest & { draftId?: string }): EmailDraftRequest {
  if (!args.draftId) return args
  const draft = emailService.getDraft(args.draftId)
  if (!draft) throw new Error(`Email draft not found: ${args.draftId}`)
  return draft
}

/**
 * The same message `describeEmailToSend` renders as text, kept structured so
 * the approval card can lay it out as a draft.
 *
 * The body is not truncated here the way the text detail is: the text version
 * is a preview line, but this one *is* the email, and approving something you
 * were only shown the first part of is not consent. Attachments are named
 * rather than carried — the card shows what is going, not the bytes.
 */
function previewEmailToSend(message: {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
  attachments?: EmailOutgoingAttachment[]
}): EmailDraftPreview {
  return {
    to: message.to,
    cc: message.cc?.length ? message.cc : undefined,
    bcc: message.bcc?.length ? message.bcc : undefined,
    subject: message.subject,
    body: message.body,
    attachmentNames: message.attachments?.length
      ? message.attachments.map((attachment) => attachment.filename)
      : undefined
  }
}

function describeEmailToSend(message: {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
  attachments?: EmailOutgoingAttachment[]
}): string {
  return [
    `To: ${message.to.join(', ')}`,
    message.cc?.length ? `Cc: ${message.cc.join(', ')}` : null,
    message.bcc?.length ? `Bcc: ${message.bcc.join(', ')}` : null,
    `Subject: ${message.subject}`,
    message.attachments?.length
      ? `Attachments: ${message.attachments.map((attachment) => attachment.filename).join(', ')}`
      : null,
    '',
    truncate(message.body, MAX_BODY_PREVIEW)
  ]
    .filter(Boolean)
    .join('\n')
}

function formatThreads(threads: EmailThreadSummary[]): { modelResult: string; detail: string } {
  if (threads.length === 0) {
    return { modelResult: 'No email threads found.', detail: '0 threads' }
  }

  return {
    modelResult: threads
      .map(
        (thread, index) =>
          `${index + 1}. [threadId: ${thread.id}; latestMessageId: ${thread.latestMessageId}; account: ${
            thread.accountId
          }] ${thread.subject}\nFrom: ${thread.from}\nUpdated: ${new Date(
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
      `Account: ${draft.accountId}`,
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

/**
 * Tool results land directly in the model's context, so a listing is capped far
 * below what the Email page may request. Without this the raised service ceiling
 * would let one `list_threads` call flood the context with hundreds of threads.
 */
const MAX_TOOL_THREADS = 20

function toolLimit(limit: number | undefined): number {
  if (limit === undefined) return 10
  return Math.min(Math.max(1, Math.floor(limit)), MAX_TOOL_THREADS)
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}
