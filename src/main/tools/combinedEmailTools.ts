import { emailService } from '../email/EmailService'
import type { DefineChatSessionFunction, ToolFunction, ToolRuntimeContext } from './types'
import { runReadTool } from './helpers'
import { resolveEmailTarget, type EmailTarget } from './emailTarget'

/**
 * Five email tools in place of seventeen, for a local model in a plain chat.
 *
 * Measured on 19 email questions against the same mailbox, Llama 3.1 8B with
 * the separate tools in view saved a draft for "Reply to Sinistercraftnetwork's
 * email saying: Got it, thanks!" and for "Send an email to …", listed threads
 * when it should have searched, and answered "You need to get the ID of the
 * latest Runpod email first" to "Forward the latest Runpod email". Each of those
 * is a choice between two tools that do nearly the same thing, or a step (an
 * id) the person never thinks about.
 *
 * So each tool here is one job the person names, and takes the email the way
 * they name it: an id, or words such as "the latest Runpod email"
 * (`resolveEmailTarget`). The work is done by the separate tools underneath,
 * through their own handlers, so every approval, card and safety rule is the
 * one that tool already has. Registered only beside them (`buildTools`), and
 * the separate tools stay one gateway step away.
 */
export interface EmailToolParts {
  list_threads?: ToolFunction
  search_email?: ToolFunction
  read_email?: ToolFunction
  find_attachments?: ToolFunction
  read_email_attachment?: ToolFunction
  view_email_attachment?: ToolFunction
  send_email?: ToolFunction
  reply_email?: ToolFunction
  forward_email?: ToolFunction
  save_email_draft?: ToolFunction
  manage_email?: ToolFunction
  move_email?: ToolFunction
  batch_email?: ToolFunction
}

/** The separate tools these stand in for, kept behind the gateway where these are shown. */
export const COMBINED_EMAIL_STANDS_IN_FOR = [
  'list_threads',
  'search_email',
  'read_email',
  'summarize_thread',
  'find_attachments',
  'read_email_attachment',
  'view_email_attachment',
  'draft_email',
  'save_email_draft',
  'send_email',
  'reply_email',
  'forward_email',
  'manage_email',
  'move_email',
  'batch_email'
] as const

const EMAIL_PARAM = {
  type: 'string',
  description:
    'The email: its thread or message id from find_email, or words that name it, e.g. "the latest Runpod email" or "Wtf. from Reddit".'
} as const

const ACCOUNT_PARAM = {
  type: 'string',
  description: 'Optional account address. Leave out for the default account.'
} as const

/** A model's email reference, under whichever name it chose to pass it. */
interface EmailRef {
  email?: string
  threadId?: string
  messageId?: string
  account?: string
}

function emailWords(args: EmailRef): string | undefined {
  return (args.email ?? args.messageId ?? args.threadId)?.trim() || undefined
}

/** A small model passes one address as a string as often as a list. */
function addresses(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const list = value.map(String).flatMap((entry) => entry.split(/[,;]/))
    const clean = list.map((entry) => entry.trim()).filter(Boolean)
    return clean.length > 0 ? clean : undefined
  }
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,;]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  return undefined
}

/** `"James" <james@example.com>` → `james@example.com`; a bare address as it is. */
function senderAddress(from: string): string {
  return /<([^>]+)>/.exec(from)?.[1]?.trim() ?? from.trim()
}

/**
 * The message a reply, forward or read is written against: the newest in the
 * thread named. For a reply, the newest someone else sent: replying to the
 * person's own last message addresses the reply to themselves. Measured: a
 * thread whose newest message was the account's own earlier reply had
 * "Got it, thanks!" addressed back to the account.
 */
async function latestMessageId(
  target: EmailTarget,
  account?: string,
  { fromSomeoneElse = false }: { fromSomeoneElse?: boolean } = {}
): Promise<string> {
  if (target.messageId) return target.messageId
  const messages = await emailService.getThreadMessages(target.threadId ?? '', account)
  const own = new Set(
    emailService.getStatus().accounts.map((linked) => linked.address.toLowerCase())
  )
  const theirs = fromSomeoneElse
    ? messages.filter((message) => !own.has(senderAddress(message.from).toLowerCase()))
    : []
  const latest = theirs.at(-1) ?? messages.at(-1)
  if (!latest) throw new Error(`${target.label} has no messages to act on.`)
  return latest.id
}

function refusal(
  ctx: ToolRuntimeContext,
  name: string,
  args: unknown,
  reason: string
): Promise<string> {
  return runReadTool(ctx, {
    name,
    kind: 'read',
    title: name.replace(/_/g, ' '),
    args,
    run: () => Promise.reject(new Error(reason))
  })
}

function switchedOff(
  ctx: ToolRuntimeContext,
  name: string,
  args: unknown,
  what: string
): Promise<string> {
  return refusal(ctx, name, args, `${what} is switched off in Settings.`)
}

interface FindEmailArgs {
  words?: string
  query?: string
  mailbox?: string
  limit?: number
  account?: string
}

function findEmailTool(
  define: DefineChatSessionFunction,
  ctx: ToolRuntimeContext,
  parts: EmailToolParts
): ToolFunction {
  return define({
    description:
      'Find the person\'s own emails. words "" lists the newest in a folder, the inbox by default; other words search every folder for them (a sender, a subject, a topic). Each result says whether it is unread.',
    params: {
      type: 'object',
      properties: {
        // Required, though "" is allowed: with nothing required, Llama 3.1 8B
        // called this for "What is an email newsletter?" in four runs of four,
        // and never called search_email (which needs a query) in three.
        words: {
          type: 'string',
          description: 'What to look for, e.g. "Runpod" or "security alert", or "" for the newest.'
        },
        mailbox: {
          type: 'string',
          description: 'With words "": the folder to list, e.g. "Trash". Defaults to the inbox.'
        },
        limit: { type: 'number', description: 'Optional: how many, up to 20. Defaults to 10.' },
        account: ACCOUNT_PARAM
      },
      required: ['words']
    } as const,
    handler: async (args: FindEmailArgs): Promise<unknown> => {
      const words = (args.words ?? args.query)?.trim()
      if (words) {
        if (!parts.search_email) return switchedOff(ctx, 'find_email', args, 'Searching email')
        return parts.search_email.handler({
          query: words,
          limit: args.limit,
          account: args.account
        })
      }
      if (!parts.list_threads) return switchedOff(ctx, 'find_email', args, 'Listing email')
      return parts.list_threads.handler({
        mailbox: args.mailbox,
        limit: args.limit,
        account: args.account
      })
    }
  })
}

function openEmailTool(
  define: DefineChatSessionFunction,
  ctx: ToolRuntimeContext,
  parts: EmailToolParts
): ToolFunction {
  return define({
    description:
      'Read one email in full: who sent it, when, the text, and its attachments. For a conversation, the newest message in it.',
    params: {
      type: 'object',
      properties: { email: EMAIL_PARAM, account: ACCOUNT_PARAM },
      required: ['email']
    } as const,
    handler: async (args: EmailRef): Promise<unknown> => {
      if (!parts.read_email) return switchedOff(ctx, 'open_email', args, 'Reading email')
      const words = emailWords(args)
      if (!words) return refusal(ctx, 'open_email', args, 'Say which email to open.')
      let messageId: string
      try {
        // A read can take the newest of several matches: opening the wrong one
        // changes nothing, and listing them costs the reply a round.
        const target = await resolveEmailTarget(
          { threadId: words, account: args.account },
          { newestOfSeveral: true }
        )
        messageId = await latestMessageId(target, args.account)
      } catch (error) {
        return refusal(ctx, 'open_email', args, (error as Error).message)
      }
      return parts.read_email.handler({ messageId, account: args.account })
    }
  })
}

interface WriteEmailArgs extends EmailRef {
  action?: 'send' | 'reply' | 'forward' | 'draft'
  to?: unknown
  cc?: unknown
  subject?: string
  body?: string
  attachmentPaths?: string[]
  replyAll?: boolean
}

/**
 * What `write_email` was asked to do when the model left `action` out, from
 * what it gave: an email and recipients is a forward, an email alone is a
 * reply, recipients alone is a new message. A draft is only ever asked for.
 */
export function writeEmailAction(args: WriteEmailArgs): 'send' | 'reply' | 'forward' | 'draft' {
  if (args.action) return args.action
  const email = emailWords(args)
  if (email && addresses(args.to)) return 'forward'
  if (email) return 'reply'
  return 'send'
}

function writeEmailTool(
  define: DefineChatSessionFunction,
  ctx: ToolRuntimeContext,
  parts: EmailToolParts
): ToolFunction {
  return define({
    description:
      'Write an email; the person approves every message before it goes. "send": a new email; give to, subject and body. "reply": answer an email; give email and body. "forward": pass an email on; give email and to. "draft": save it unsent in their Drafts folder, only when they ask for a draft; give email too to draft a reply to it. Leave action out and it is chosen from what you give.',
    params: {
      type: 'object',
      properties: {
        action: {
          enum: ['send', 'reply', 'forward', 'draft'],
          description: 'What to do. Optional: see above.'
        },
        email: {
          ...EMAIL_PARAM,
          description: `For reply and forward: ${EMAIL_PARAM.description}`
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'For send, forward and draft: the addresses it goes to.'
        },
        cc: { type: 'array', items: { type: 'string' }, description: 'Optional CC addresses.' },
        subject: { type: 'string', description: 'For send and draft: the subject.' },
        body: {
          type: 'string',
          description: 'The words of the message. For forward, an optional note above it.'
        },
        attachmentPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional files to attach, by the name of a file attached to this chat.'
        },
        replyAll: {
          type: 'boolean',
          description: 'For reply: to everyone on the original, not just the sender.'
        },
        account: ACCOUNT_PARAM
      }
    } as const,
    handler: async (args: WriteEmailArgs): Promise<unknown> => {
      const action = writeEmailAction(args)
      const to = addresses(args.to)
      const cc = addresses(args.cc)
      const body = args.body?.trim() ?? ''

      if (action === 'send' || action === 'draft') {
        const tool = action === 'send' ? parts.send_email : parts.save_email_draft
        if (!tool) {
          return switchedOff(
            ctx,
            'write_email',
            args,
            action === 'send' ? 'Sending email' : 'Saving drafts'
          )
        }
        if (!body)
          return refusal(ctx, 'write_email', args, 'Give the words of the message, in body.')
        // "Draft a reply to the latest Runpod email": a draft written against an
        // email goes to its sender, under its subject. Gemma 4 E4B passed the
        // email and no address, and was told to give one.
        let replyingTo: { to: string[]; subject: string } | null = null
        const words = emailWords(args)
        if (action === 'draft' && words && !to) {
          try {
            const target = await resolveEmailTarget(
              { threadId: words, account: args.account },
              { newestOfSeveral: true }
            )
            const message = await emailService.readMessage(
              await latestMessageId(target, args.account, { fromSomeoneElse: true }),
              args.account
            )
            replyingTo = {
              to: addresses(senderAddress(message.from)) ?? [],
              subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`
            }
          } catch (error) {
            return refusal(ctx, 'write_email', args, (error as Error).message)
          }
        }
        const recipients = to ?? replyingTo?.to
        if (!recipients?.length) {
          return refusal(ctx, 'write_email', args, 'Give the address it goes to, in to.')
        }
        return tool.handler({
          to: recipients,
          cc,
          subject: args.subject?.trim() || replyingTo?.subject || '',
          body,
          attachmentPaths: args.attachmentPaths,
          account: args.account
        })
      }

      const tool = action === 'reply' ? parts.reply_email : parts.forward_email
      if (!tool) {
        return switchedOff(
          ctx,
          'write_email',
          args,
          action === 'reply' ? 'Replying to email' : 'Forwarding email'
        )
      }
      const words = emailWords(args)
      if (!words) {
        return refusal(ctx, 'write_email', args, `Say which email to ${action} to, in email.`)
      }
      if (action === 'reply' && !body) {
        return refusal(ctx, 'write_email', args, 'Give the words of the reply, in body.')
      }
      if (action === 'forward' && !to) {
        return refusal(ctx, 'write_email', args, 'Give the address to forward it to, in to.')
      }
      let messageId: string
      try {
        // The newest of several, as a read does: the approval card names the
        // email before anything goes, so a wrong pick is caught there. Measured:
        // "Reply to Sinistercraftnetwork's email" found two of theirs and was
        // refused, where the person meant their latest.
        const target = await resolveEmailTarget(
          { threadId: words, account: args.account },
          { newestOfSeveral: true }
        )
        messageId = await latestMessageId(target, args.account, {
          fromSomeoneElse: action === 'reply'
        })
      } catch (error) {
        return refusal(ctx, 'write_email', args, (error as Error).message)
      }
      return action === 'reply'
        ? tool.handler({
            messageId,
            body,
            cc,
            replyAll: args.replyAll,
            attachmentPaths: args.attachmentPaths,
            account: args.account
          })
        : tool.handler({ messageId, to, cc, body: body || undefined, account: args.account })
    }
  })
}

interface AttachmentArgs extends EmailRef {
  attachment?: string
}

function emailAttachmentsTool(
  define: DefineChatSessionFunction,
  ctx: ToolRuntimeContext,
  parts: EmailToolParts
): ToolFunction {
  const canView = Boolean(ctx.visualInputs && parts.view_email_attachment)
  return define({
    description: canView
      ? 'The files attached to an email. Give email alone to list them. Give attachment too, by its name, number or id, to read a document or look at a picture.'
      : 'The files attached to an email. Give email alone to list them. Give attachment too, by its name, number or id, to read a document (PDF, text, CSV).',
    params: {
      type: 'object',
      properties: {
        email: EMAIL_PARAM,
        attachment: {
          type: 'string',
          description:
            'Optional: which file, by its name ("invoice.pdf"), its number in the list, or its id.'
        },
        account: ACCOUNT_PARAM
      },
      required: ['email']
    } as const,
    handler: async (args: AttachmentArgs): Promise<unknown> => {
      const words = emailWords(args)
      if (!words) return refusal(ctx, 'email_attachments', args, 'Say which email, in email.')
      let threadId: string
      let messages: Awaited<ReturnType<typeof emailService.getThreadMessages>>
      try {
        const target = await resolveEmailTarget(
          { threadId: words, account: args.account },
          { newestOfSeveral: true }
        )
        threadId =
          target.threadId ??
          (await emailService.readMessage(target.messageId ?? '', args.account)).threadId
        messages = await emailService.getThreadMessages(threadId, args.account)
      } catch (error) {
        return refusal(ctx, 'email_attachments', args, (error as Error).message)
      }

      const wanted = args.attachment?.trim()
      const all = messages.flatMap((message) => message.attachments)
      if (!wanted && all.length !== 1) {
        if (!parts.find_attachments) {
          return switchedOff(ctx, 'email_attachments', args, 'Listing attachments')
        }
        return parts.find_attachments.handler({ threadId, account: args.account })
      }
      const chosen = wanted ? pickAttachment(all, wanted) : all[0]
      if (!chosen) {
        return refusal(
          ctx,
          'email_attachments',
          args,
          `No attachment matches "${wanted}". This email has: ${
            all.map((file, index) => `${index + 1}. ${file.filename}`).join(', ') || 'none'
          }.`
        )
      }
      const looksAtIt = canView && chosen.mimeType.startsWith('image/')
      const tool = looksAtIt ? parts.view_email_attachment : parts.read_email_attachment
      if (!tool) return switchedOff(ctx, 'email_attachments', args, 'Reading attachments')
      return tool.handler({
        messageId: chosen.messageId,
        attachmentId: chosen.id,
        account: args.account
      })
    }
  })
}

/** An attachment by id, by its number in the list, or by part of its file name. */
export function pickAttachment<T extends { id: string; filename: string }>(
  attachments: T[],
  wanted: string
): T | undefined {
  const byId = attachments.find((file) => file.id === wanted)
  if (byId) return byId
  const number = /^#?(\d+)$/.exec(wanted)?.[1]
  if (number) return attachments[Number(number) - 1]
  const lower = wanted.toLowerCase()
  const named = attachments.filter((file) => file.filename.toLowerCase().includes(lower))
  return named.length === 1 ? named[0] : undefined
}

type OrganizeAction =
  'mark_read' | 'mark_unread' | 'star' | 'unstar' | 'archive' | 'unarchive' | 'move' | 'trash'

interface OrganizeArgs extends EmailRef {
  action?: OrganizeAction
  matching?: string
  every?: boolean
  mailbox?: string
}

function organizeEmailTool(
  define: DefineChatSessionFunction,
  ctx: ToolRuntimeContext,
  parts: EmailToolParts
): ToolFunction {
  return define({
    description:
      'Tidy email: mark read or unread, star, archive, move to a folder, or move to the Trash. Give email for one email. Only when the person asks for all of them ("all my Instagram emails"), give matching with the words and every: true. Nothing is ever deleted for good.',
    params: {
      type: 'object',
      properties: {
        action: {
          enum: [
            'mark_read',
            'mark_unread',
            'star',
            'unstar',
            'archive',
            'unarchive',
            'move',
            'trash'
          ],
          description: 'What to do.'
        },
        email: { ...EMAIL_PARAM, description: `For one email: ${EMAIL_PARAM.description}` },
        matching: {
          type: 'string',
          description: 'With every: the words that find all the emails meant, e.g. "Instagram".'
        },
        every: {
          type: 'boolean',
          description: 'true only when the person asked for all of them. Leave out for one email.'
        },
        mailbox: { type: 'string', description: 'For move: the folder to move it to.' },
        account: ACCOUNT_PARAM
      },
      required: ['action']
    } as const,
    handler: async (args: OrganizeArgs): Promise<unknown> => {
      const action = args.action
      if (!action) return refusal(ctx, 'organize_email', args, 'Say what to do, in action.')
      // The Trash is a folder like any other; the adapters find it by what the
      // server says it is for, whatever it is called (see `folderNames.ts`).
      const destination = action === 'trash' ? 'Trash' : args.mailbox?.trim()
      const moving = action === 'move' || action === 'trash'
      if (moving && !destination) {
        return refusal(ctx, 'organize_email', args, 'Say which folder to move it to, in mailbox.')
      }

      // Every match only when that was asked for in so many words. Measured:
      // Llama 3.1 8B passed matching "Reddit" for "Move the Reddit email titled
      // Wtf. to the trash." and the card asked to move 25 emails. Without
      // `every`, matching is read as naming one email, which lists the
      // candidates when it names several instead of acting on all of them.
      const matching = args.matching?.trim()
      if (matching && args.every === true) {
        if (!parts.batch_email) return switchedOff(ctx, 'organize_email', args, 'Tidying email')
        return parts.batch_email.handler({
          action: moving ? 'move' : action,
          query: matching,
          destination: moving ? destination : undefined,
          account: args.account
        })
      }

      const words = emailWords(args) ?? matching
      if (!words) {
        return refusal(
          ctx,
          'organize_email',
          args,
          'Say which email, in email, or which emails, in matching with every: true.'
        )
      }
      const tool = moving ? parts.move_email : parts.manage_email
      if (!tool) return switchedOff(ctx, 'organize_email', args, 'Tidying email')
      let target: EmailTarget
      try {
        target = await resolveEmailTarget({ threadId: words, account: args.account })
      } catch (error) {
        const several = /More than one email matches/.test((error as Error).message)
        return refusal(
          ctx,
          'organize_email',
          args,
          several && parts.batch_email
            ? `${(error as Error).message}\nIf the person asked for all of them, give matching and every: true.`
            : (error as Error).message
        )
      }
      const ids = { threadId: target.threadId, messageId: target.messageId }
      return moving
        ? tool.handler({ mailbox: destination, ...ids, account: args.account })
        : tool.handler({ action, ...ids, account: args.account })
    }
  })
}

/** The combined tools that have something underneath them to do the work. */
export function combinedEmailTools(
  define: DefineChatSessionFunction,
  ctx: ToolRuntimeContext,
  parts: EmailToolParts
): Record<string, ToolFunction> {
  const tools: Record<string, ToolFunction> = {}
  if (parts.search_email || parts.list_threads) tools.find_email = findEmailTool(define, ctx, parts)
  if (parts.read_email) tools.open_email = openEmailTool(define, ctx, parts)
  if (parts.send_email || parts.reply_email || parts.forward_email || parts.save_email_draft) {
    tools.write_email = writeEmailTool(define, ctx, parts)
  }
  if (parts.find_attachments || parts.read_email_attachment) {
    tools.email_attachments = emailAttachmentsTool(define, ctx, parts)
  }
  if (parts.manage_email || parts.move_email || parts.batch_email) {
    tools.organize_email = organizeEmailTool(define, ctx, parts)
  }
  return tools
}
