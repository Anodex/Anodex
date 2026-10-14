import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { app } from 'electron'
import { formatBytes } from '@shared/format'
import type { ToolFactory } from './types'
import { runGuardedTool, runReadTool } from './helpers'
import { resolveInWorkspace } from './workspace'
import { searchPersonalFiles } from '../files/personalFiles'
import { settingsStore } from '../settings/SettingsStore'
import { emailService } from '../email/EmailService'
import { MAX_SHARE_BYTES, mimeTypeFor, phoneShares } from '../files/phoneShares'
import { notifyFileShared } from '../remote/fileShared'

/** Bigger than this does not go by email: most providers refuse around 25MB. */
const MAX_EMAIL_BYTES = 20 * 1024 * 1024
/** How long a search result stays sendable. */
const FOUND_TTL_MS = 60 * 60 * 1000

/**
 * The files `find_my_files` turned up, per conversation. `send_file_to_me`
 * sends only these (or files in the open project), so a request to mail some
 * other file off the computer is refused, even to the person's own address.
 */
const found = new Map<string, Map<string, number>>()

function remember(conversationId: string, paths: string[]): void {
  const now = Date.now()
  const known = found.get(conversationId) ?? new Map<string, number>()
  for (const [path, at] of known) if (now - at > FOUND_TTL_MS) known.delete(path)
  for (const path of paths) known.set(path, now)
  found.set(conversationId, known)
}

function wasFound(conversationId: string, path: string): boolean {
  const at = found.get(conversationId)?.get(path)
  return at !== undefined && Date.now() - at <= FOUND_TTL_MS
}

/** The person's own folders, wherever this OS keeps them. */
function personalRoots(): string[] {
  const read = (name: 'desktop' | 'documents' | 'downloads'): string | null => {
    try {
      return app.getPath(name)
    } catch {
      return null
    }
  }
  const roots = [
    read('documents'),
    read('desktop'),
    read('downloads'),
    process.env.OneDrive ?? null,
    join(homedir(), 'OneDrive')
  ].filter((root): root is string => Boolean(root) && existsSync(root as string))
  return [...new Set(roots)]
}

function shortPath(path: string): string {
  const home = homedir()
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

/**
 * The first line of a find_my_files result.
 *
 * A file found only because its contents mention the words is a lead, not the
 * thing asked for, and the result says so. Measured with Llama 3.1 8B: "What
 * does my todo list say?" found a design document that mentions a "todo" in
 * passing, under "Found 1 file:", and the reply was "Your todo list is in the
 * file REVIEW_LOG_VISUAL_RUNTIME_EVIDENCE.md".
 */
export function foundHeading(words: string, results: { matched: string }[]): string {
  const count = `${results.length} file${results.length === 1 ? '' : 's'}`
  if (results.some((file) => file.matched === 'name')) return `Found ${count}:`
  return (
    `No file is named for "${words}". Found ${count} that only mention it inside, ` +
    'which may not be what the person means: say what was found rather than calling it theirs.'
  )
}

/**
 * find_my_files — look through the person's own folders for a file.
 *
 * "Send me the budget for Friday's meeting" from a phone starts here. Searches
 * Documents, Desktop, Downloads and OneDrive by name, then inside documents
 * (text, PDF, Word, Excel, PowerPoint, OpenDocument). Read-only, so it never
 * asks; hidden files and folders are never searched.
 */
export const findMyFilesTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Search the person\'s own folders (Documents, Desktop, Downloads, OneDrive) for a file, by name and inside documents (text, PDF, Word, Excel, PowerPoint). Give one to three distinctive words, e.g. "budget" or "budget friday"; every word must match. Read-only. Use send_file_to_me to send one of the results to the person.',
    params: {
      type: 'object',
      properties: {
        words: { type: 'string', description: 'The words to look for, e.g. "budget friday".' },
        within_days: {
          type: 'number',
          description: 'Only files changed in the last this-many days. Optional.'
        }
      },
      required: ['words']
    } as const,
    handler: (args: { words: string; within_days?: number }) =>
      runReadTool(ctx, {
        name: 'find_my_files',
        kind: 'read',
        title: `Find files: ${args.words}`,
        args,
        async run() {
          const roots = personalRoots()
          const results = await searchPersonalFiles({
            roots,
            words: args.words.split(/\s+/),
            withinDays: args.within_days
          })
          remember(
            ctx.conversationId,
            results.map((file) => file.path)
          )
          if (results.length === 0) {
            return {
              modelResult: `Nothing matched "${args.words}" in ${roots.map(shortPath).join(', ')}. Try fewer or different words.`,
              madeProgress: false
            }
          }
          return {
            modelResult: [
              foundHeading(args.words, results),
              ...results.map(
                (file) =>
                  `- ${file.path} (${formatBytes(file.sizeBytes)}, changed ${new Date(file.modifiedAt).toLocaleDateString()}; matched ${file.matched})`
              )
            ].join('\n'),
            detail: `${results.length} found`
          }
        }
      })
  })

/**
 * send_file_to_me — get a file to the person away from their computer.
 *
 * To their paired phone when there is one: the file waits on this computer's
 * shelf (`phoneShares.ts`) and the phone is told, then saves it to its
 * Downloads. Otherwise by email to their own linked address. Email used to be
 * the only way, and it is not set up by default, so for most people "send it to
 * my phone" did nothing. Only a file find_my_files found in this chat or one
 * inside the open project. The phone is the person's own device, so that way
 * asks only in Ask mode; email asks in Ask and Edits mode.
 */
export const sendFileToMeTool: ToolFactory = (define, ctx) =>
  define({
    description:
      "Send a file to the person so they can open it away from the computer: to their paired phone (it saves to the phone's Downloads) or by email to their own address. Defaults to the phone when one is paired. Only files found with find_my_files in this chat, or files in the open project.",
    params: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The file, exactly as find_my_files listed it, or a project path.'
        },
        note: { type: 'string', description: 'Optional one line to put in the email.' },
        to: {
          type: 'string',
          enum: ['phone', 'email'],
          description: 'Where to send it. Leave out to use the phone when one is paired.'
        }
      },
      required: ['path']
    } as const,
    handler: async (args: { path: string; note?: string; to?: 'phone' | 'email' }) => {
      // A refusal fails the call rather than returning normally. Returned, it was
      // recorded as a success, and the phone and desktop both labelled it "Sent
      // you a file": measured from a phone, "Remind me in 2 minutes to stretch."
      // reached this tool, was refused, and the transcript said a file was sent.
      const refuse = (reason: string): Promise<string> =>
        runReadTool(ctx, {
          name: 'send_file_to_me',
          kind: 'read',
          title: `Send ${basename(args.path)}`,
          args,
          run: () => Promise.reject(new Error(reason))
        })

      let path = args.path.trim()
      if (!wasFound(ctx.conversationId, path)) {
        if (!ctx.workspaceRoot) {
          return refuse(
            'Only a file find_my_files found in this chat can be sent. Search for it first.'
          )
        }
        try {
          path = resolveInWorkspace(ctx.workspaceRoot, path)
        } catch {
          return refuse(
            'Only a file find_my_files found in this chat, or one in the open project, can be sent.'
          )
        }
      }
      const { accounts, primaryAccountId } = settingsStore.get().email
      const account = accounts.find((a) => a.id === primaryAccountId) ?? accounts[0]
      // Read when needed: the remote service is built around Electron's app paths.
      const { remoteService } = await import('../remote/RemoteService')
      const phonePaired = remoteService.status().pairedDevices.length > 0
      const toPhone = args.to === 'phone' || (args.to !== 'email' && (phonePaired || !account))
      if (toPhone && !phonePaired) {
        return refuse(
          account
            ? 'No phone is paired. Send it by email instead (to: "email"), or pair the phone in Settings → Remote.'
            : 'No phone is paired and no email account is linked. Pair the phone in Settings → Remote, or link an email account in Settings → Email.'
        )
      }
      if (!toPhone && !account) {
        return refuse(
          'No email account is linked, so the file cannot be emailed. Send it to the phone instead, or link an account in Settings → Email.'
        )
      }
      let size: number
      try {
        const stats = await stat(path)
        if (!stats.isFile()) return refuse(`${shortPath(path)} is not a file.`)
        size = stats.size
      } catch {
        return refuse(`${shortPath(path)} no longer exists.`)
      }
      const name = basename(path)
      if (toPhone) {
        if (size > MAX_SHARE_BYTES) {
          return refuse(
            `${name} is ${formatBytes(size)}, too big to send to the phone (the limit is ${formatBytes(MAX_SHARE_BYTES)}).`
          )
        }
        return runGuardedTool(ctx, {
          name: 'send_file_to_me',
          kind: 'command',
          title: `Send ${name} to your phone`,
          args,
          confirmDetail: `Send ${name} (${formatBytes(size)}) to your paired phone`,
          risk: 'safe',
          async run() {
            const share = await (await phoneShares()).add(path)
            const told = notifyFileShared(share)
            return {
              modelResult:
                told > 0
                  ? `Sent ${name} (${formatBytes(size)}) to their phone. It shows as a notification, and saves to the phone's Downloads from there or from the Anodex app.`
                  : `${name} is waiting for their phone, which is not connected right now. It appears in the Anodex app the next time the phone connects (phone app 0.90 or later), for up to a week.`,
              detail: told > 0 ? 'sent to your phone' : 'waiting for your phone'
            }
          }
        })
      }
      if (!account) return refuse('No email account is linked.')
      if (size > MAX_EMAIL_BYTES) {
        return refuse(
          `${basename(path)} is ${formatBytes(size)}, too big to email (the limit is ${formatBytes(MAX_EMAIL_BYTES)}).`
        )
      }
      return runGuardedTool(ctx, {
        name: 'send_file_to_me',
        kind: 'web',
        title: `Email ${name} to you`,
        args,
        confirmDetail: `Email ${name} (${formatBytes(size)}) to your own address, ${account.address}`,
        risk: 'sensitive',
        async run() {
          const data = await readFile(path)
          await emailService.send({
            accountId: account.id,
            to: [account.address],
            subject: name,
            body: `${args.note?.trim() ? `${args.note.trim()}\n\n` : ''}Sent from Anodex: ${shortPath(path)}`,
            attachments: [
              {
                filename: name,
                mimeType: mimeTypeFor(name),
                contentBase64: data.toString('base64')
              }
            ]
          })
          return {
            modelResult: `Emailed ${name} (${formatBytes(size)}) to ${account.address}. It is in their inbox; the phone's email screen can open and save it.`,
            detail: `emailed to ${account.address}`
          }
        }
      })
    }
  })
