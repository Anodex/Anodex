import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { app } from 'electron'
import { formatBytes } from '@shared/format'
import type { ToolFactory } from './types'
import { runGuardedTool, runReadTool } from './helpers'
import { resolveInWorkspace } from './workspace'
import { searchPersonalFiles } from '../files/personalFiles'
import { settingsStore } from '../settings/SettingsStore'
import { emailService } from '../email/EmailService'

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
              `Found ${results.length} file${results.length === 1 ? '' : 's'}:`,
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

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
}

/**
 * send_file_to_me — email a file to the person's own address.
 *
 * The way to get a document to someone away from their computer: it lands in
 * their inbox, which the phone's email screen can open and save. Only to the
 * person's own linked address, from that same account, and only a file
 * find_my_files found in this chat or one inside the open project. Asks in Ask
 * and Edits mode, goes ahead in Untethered.
 */
export const sendFileToMeTool: ToolFactory = (define, ctx) =>
  define({
    description:
      "Email a file to the person's own address, so they can open it away from the computer (the phone's email screen can download it). Only files found with find_my_files in this chat, or files in the open project.",
    params: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The file, exactly as find_my_files listed it, or a project path.'
        },
        note: { type: 'string', description: 'Optional one line to put in the email.' }
      },
      required: ['path']
    } as const,
    handler: async (args: { path: string; note?: string }) => {
      const refuse = (reason: string): Promise<string> =>
        runReadTool(ctx, {
          name: 'send_file_to_me',
          kind: 'read',
          title: `Send ${basename(args.path)}`,
          args,
          run: () => Promise.resolve({ modelResult: reason, madeProgress: false })
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
      if (!account) {
        return refuse(
          'No email account is linked, so the file cannot be emailed. Link one in Settings → Email.'
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
      if (size > MAX_EMAIL_BYTES) {
        return refuse(
          `${basename(path)} is ${formatBytes(size)}, too big to email (the limit is ${formatBytes(MAX_EMAIL_BYTES)}).`
        )
      }
      const name = basename(path)
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
                mimeType: MIME_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream',
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
