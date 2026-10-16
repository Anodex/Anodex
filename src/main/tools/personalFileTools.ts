import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
import { app } from 'electron'
import { formatBytes } from '@shared/format'
import type {
  DefineChatSessionFunction,
  ToolFactory,
  ToolFunction,
  ToolRuntimeContext
} from './types'
import { runGuardedTool, runReadTool } from './helpers'
import { resolveInWorkspace } from './workspace'
import { expandHomeShorthand } from './homeShorthand'
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

/** The folders `my_files` can list, by the names a person uses for them. */
export const PERSONAL_FOLDERS = ['Downloads', 'Desktop', 'Documents', 'OneDrive'] as const
export type PersonalFolder = (typeof PERSONAL_FOLDERS)[number]

/** The person's own folders that exist on this computer, wherever this OS keeps them. */
function personalFolders(): { name: PersonalFolder; root: string }[] {
  const read = (name: 'desktop' | 'documents' | 'downloads'): string | null => {
    try {
      return app.getPath(name)
    } catch {
      return null
    }
  }
  const candidates: { name: PersonalFolder; root: string | null }[] = [
    { name: 'Documents', root: read('documents') },
    { name: 'Desktop', root: read('desktop') },
    { name: 'Downloads', root: read('downloads') },
    { name: 'OneDrive', root: process.env.OneDrive ?? null },
    { name: 'OneDrive', root: join(homedir(), 'OneDrive') }
  ]
  const seen = new Set<string>()
  const folders: { name: PersonalFolder; root: string }[] = []
  for (const { name, root } of candidates) {
    if (!root || seen.has(root) || !existsSync(root)) continue
    seen.add(root)
    folders.push({ name, root })
  }
  return folders
}

/** The person's own folders, wherever this OS keeps them. */
function personalRoots(): string[] {
  return personalFolders().map((folder) => folder.root)
}

/** Whether `path` is inside `root`, by the platform's own rules (case-insensitive on Windows). */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
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

/** The most entries a folder listing shows. */
const MAX_LISTED = 25
/** The most entries a folder listing reads sizes and dates for. */
const MAX_LIST_READS = 2_000

interface ListedEntry {
  name: string
  path: string
  isFolder: boolean
  sizeBytes: number
  modifiedAt: number
}

/** One personal folder's contents, newest or biggest first, hidden entries left out. */
export async function listFolder(
  root: string,
  sort: 'newest' | 'biggest'
): Promise<{ entries: ListedEntry[]; total: number }> {
  const names = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => !entry.name.startsWith('.')
  )
  const entries: ListedEntry[] = []
  for (const entry of names.slice(0, MAX_LIST_READS)) {
    const path = join(root, entry.name)
    try {
      const stats = await stat(path)
      entries.push({
        name: entry.name,
        path,
        isFolder: stats.isDirectory(),
        sizeBytes: stats.isDirectory() ? 0 : stats.size,
        modifiedAt: stats.mtimeMs
      })
    } catch {
      // Gone, or not ours to read: leave it out rather than fail the listing.
    }
  }
  entries.sort((a, b) =>
    sort === 'biggest' ? b.sizeBytes - a.sizeBytes : b.modifiedAt - a.modifiedAt
  )
  return { entries, total: names.length }
}

/**
 * Where `file` is, among the person's own folders: a path the search or a
 * listing gave, a full path inside one of those folders, or a file's exact
 * name, looked up by name the way find_my_files would. A name that matches
 * more than one file is an error that lists them, so the model can say which.
 */
async function locateMine(conversationId: string, file: string): Promise<string> {
  const raw = file.trim()
  const expanded = expandHomeShorthand(raw) ?? raw
  const roots = personalRoots()
  if (isAbsolute(expanded)) {
    if (wasFound(conversationId, expanded)) return expanded
    if (roots.some((root) => isInside(root, expanded)) && existsSync(expanded)) {
      remember(conversationId, [expanded])
      return expanded
    }
    throw new Error(
      `${shortPath(expanded)} is not in Documents, Desktop, Downloads or OneDrive, so my_files cannot reach it.`
    )
  }
  const name = basename(expanded.replace(/\\/g, '/')).toLowerCase()
  // Only what is still there: a file found an hour ago may have been moved since.
  const known = [...(found.get(conversationId)?.keys() ?? [])].filter(
    (path) => basename(path).toLowerCase() === name && existsSync(path)
  )
  if (known.length === 1) return known[0]
  const matches = (await searchPersonalFiles({ roots, words: [name] })).filter(
    (result) => basename(result.path).toLowerCase() === name
  )
  if (matches.length === 1) {
    remember(conversationId, [matches[0].path])
    return matches[0].path
  }
  if (matches.length === 0) {
    throw new Error(
      `No file named "${basename(expanded)}" in Documents, Desktop, Downloads or OneDrive. Use action "find" with a word from its name.`
    )
  }
  remember(
    conversationId,
    matches.map((result) => result.path)
  )
  throw new Error(
    `More than one file is named "${basename(expanded)}":\n${matches.map((result) => `- ${result.path}`).join('\n')}\nGive the full path of the one meant.`
  )
}

type MyFilesArgs = {
  action: 'find' | 'list' | 'open' | 'send'
  words?: string
  folder?: PersonalFolder
  sort?: 'newest' | 'biggest'
  file?: string
  to?: 'phone' | 'email'
  within_days?: number
}

/**
 * my_files — the person's own files, in one tool: find, list, open, send.
 *
 * Measured on 54 questions with Llama 3.1 8B, picking the wrong tool was the
 * most common way a question went wrong, and most of those were here. "Send
 * E2250044A.pdf from my Downloads folder to my phone." needed find_my_files and
 * then send_file_to_me, and Llama called request_folder_access instead. "Do I
 * have a maintenance sheet for the EX1200 anywhere?" and "Search my documents
 * for anything about invoices." ran shell commands with find_my_files in view.
 * And "What files are in my Downloads folder?" had no tool at all, so it was
 * always a command, often a failing one.
 *
 * So the person's files are one name with an action, and `send` and `open`
 * take a file's name as well as a path, finding it themselves. Each action is
 * the existing tool underneath, with its own approval and limits: `send` still
 * reaches only the person's own folders and the open project, and only when
 * send_file_to_me is switched on. Shown to local models in a plain chat, which
 * then see these four instead of the separate tools (see
 * `localChatToolsOnRequest`); cloud models choose well among the separate ones
 * and keep them.
 */
export function myFilesTool(
  define: DefineChatSessionFunction,
  ctx: ToolRuntimeContext,
  parts: { find?: ToolFunction; send?: ToolFunction; open?: ToolFunction }
): ToolFunction {
  const refuse = (args: MyFilesArgs, reason: string): Promise<string> =>
    runReadTool(ctx, {
      name: 'my_files',
      kind: 'read',
      title: `My files: ${args.action}`,
      args,
      run: () => Promise.reject(new Error(reason))
    })
  return define({
    description:
      'The person\'s own files, in Documents, Desktop, Downloads and OneDrive. action "find": search by name and inside documents; give words. "list": what is in one folder, newest or biggest first; give folder. "open": open a file or folder in its usual app; give file. "send": send a file to their phone or by email; give file. A file can be a path from find or list, or its exact name.',
    params: {
      type: 'object',
      properties: {
        action: { enum: ['find', 'list', 'open', 'send'], description: 'What to do.' },
        words: { type: 'string', description: 'For find: one to three words, e.g. "budget".' },
        folder: { enum: [...PERSONAL_FOLDERS], description: 'For list: which folder.' },
        sort: {
          enum: ['newest', 'biggest'],
          description: 'For list: newest first (the default) or biggest first.'
        },
        file: {
          type: 'string',
          description: 'For open and send: a path from find or list, or the exact file name.'
        },
        to: {
          enum: ['phone', 'email'],
          description: 'For send: leave out to use the phone when one is paired.'
        },
        within_days: {
          type: 'number',
          description: 'For find: only files changed in the last this-many days.'
        }
      },
      required: ['action']
    } as const,
    handler: async (args: MyFilesArgs): Promise<unknown> => {
      switch (args.action) {
        case 'find':
          if (!parts.find) return refuse(args, 'Finding files is switched off in Settings.')
          if (!args.words?.trim()) return refuse(args, 'Give the words to look for.')
          return parts.find.handler({ words: args.words, within_days: args.within_days })
        case 'list':
          return listMine(ctx, args)
        case 'open':
        case 'send': {
          const tool = args.action === 'open' ? parts.open : parts.send
          if (!tool) {
            return refuse(
              args,
              `${args.action === 'open' ? 'Opening' : 'Sending'} files is switched off in Settings.`
            )
          }
          if (!args.file?.trim()) return refuse(args, 'Give the file, by its name or path.')
          // A web address is open_item's to open as it is.
          if (args.action === 'open' && /^https?:\/\//i.test(args.file.trim())) {
            return tool.handler({ target: args.file.trim() })
          }
          let path: string
          try {
            path = await locateMine(ctx.conversationId, args.file)
          } catch (error) {
            return refuse(args, error instanceof Error ? error.message : String(error))
          }
          return args.action === 'open'
            ? tool.handler({ target: path })
            : tool.handler({ path, ...(args.to ? { to: args.to } : {}) })
        }
        default:
          return refuse(args, 'action must be find, list, open or send.')
      }
    }
  })
}

function listMine(ctx: ToolRuntimeContext, args: MyFilesArgs): Promise<string> {
  const sort = args.sort === 'biggest' ? 'biggest' : 'newest'
  return runReadTool(ctx, {
    name: 'my_files',
    kind: 'read',
    title: `List ${args.folder ?? 'a folder'}`,
    args,
    async run() {
      const folders = personalFolders()
      const folder = folders.find((candidate) => candidate.name === args.folder)
      if (!folder) {
        throw new Error(
          `Give folder as one of: ${folders.map((candidate) => candidate.name).join(', ')}.`
        )
      }
      const { entries, total } = await listFolder(folder.root, sort)
      if (total === 0) return { modelResult: `${folder.name} is empty.`, madeProgress: false }
      const shown = entries.slice(0, MAX_LISTED)
      remember(
        ctx.conversationId,
        shown.filter((entry) => !entry.isFolder).map((entry) => entry.path)
      )
      const heading =
        `${folder.name} (${shortPath(folder.root)}) has ${total} item${total === 1 ? '' : 's'}` +
        (total > shown.length
          ? `; the ${shown.length} ${sort === 'biggest' ? 'biggest' : 'newest'} are:`
          : `, ${sort === 'biggest' ? 'biggest' : 'newest'} first:`)
      return {
        modelResult: [
          heading,
          ...shown.map((entry) =>
            entry.isFolder
              ? `- ${entry.name} (folder, changed ${new Date(entry.modifiedAt).toLocaleDateString()})`
              : `- ${entry.name} (${formatBytes(entry.sizeBytes)}, changed ${new Date(entry.modifiedAt).toLocaleDateString()})`
          )
        ].join('\n'),
        detail: `${total} items`
      }
    }
  })
}
