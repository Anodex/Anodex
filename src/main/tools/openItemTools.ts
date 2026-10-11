import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { shell } from 'electron'
import type { ToolFactory } from './types'
import { runGuardedTool, runReadTool } from './helpers'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import { isSafeExternalUrl, openExternalSafely } from '../safeExternalUrl'

/**
 * Documents the OS may open in their usual app. An allowlist on purpose:
 * opening a file means running whatever claims its type, so a program, a
 * script, a shortcut or an installer is never opened, however it is named.
 */
export const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf',
  '.txt',
  '.md',
  '.log',
  '.csv',
  '.json',
  '.html',
  '.htm',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.mp4',
  '.mov',
  '.webm',
  '.mkv',
  '.docx',
  '.xlsx',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.rtf'
])

/**
 * open_item — open a web address in the browser, a folder in the file
 * manager, or a document from the project in its usual app.
 *
 * "Open the game in my browser", "show me the server folder". Only http(s)
 * addresses (through the same check every link in Anodex goes through), and
 * only folders and documents inside the open project. Programs and scripts
 * are refused, so this can never run something Anodex downloaded or wrote.
 * `safe` risk: asks in Ask mode, goes ahead otherwise.
 */
export const openItemTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Open something for the person: an http(s) address in their browser (such as a local dev server), a folder from the open project in their file manager, or a document from the project (PDF, image, text, office file) in its usual app. Never opens programs or scripts.',
    params: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'An http(s) address, or a project-relative path to a folder or document.'
        }
      },
      required: ['target']
    } as const,
    handler: async (args: { target: string }) => {
      const target = args.target.trim()
      const refuse = (reason: string): Promise<string> =>
        runReadTool(ctx, {
          name: 'open_item',
          kind: 'read',
          title: `Open ${target}`,
          args,
          run: () => Promise.resolve({ modelResult: reason, madeProgress: false })
        })

      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
        if (!isSafeExternalUrl(target)) {
          return refuse('Only plain http and https addresses can be opened.')
        }
        return runGuardedTool(ctx, {
          name: 'open_item',
          kind: 'command',
          title: `Open ${target}`,
          args,
          confirmDetail: `Open ${target} in your browser`,
          risk: 'safe',
          async run() {
            const opened = await openExternalSafely(target)
            return {
              modelResult: opened
                ? `Opened ${target} in the browser.`
                : `Could not open ${target}.`,
              madeProgress: opened
            }
          }
        })
      }

      if (!ctx.workspaceRoot) {
        return refuse(
          'Files and folders can only be opened from an open project. Ask for the folder with request_folder_access first.'
        )
      }
      let path: string
      try {
        path = resolveInWorkspace(ctx.workspaceRoot, target)
      } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error))
      }
      const relative = toWorkspaceRelative(ctx.workspaceRoot, path)
      let isFolder: boolean
      try {
        isFolder = (await stat(path)).isDirectory()
      } catch {
        return refuse(`${relative} does not exist.`)
      }
      if (!isFolder && !OPENABLE_EXTENSIONS.has(extname(path).toLowerCase())) {
        return refuse(
          `Anodex does not open ${extname(path) || 'files without an extension'}: only folders and documents, never programs or scripts. To run something, use run_command or start_process.`
        )
      }
      return runGuardedTool(ctx, {
        name: 'open_item',
        kind: 'command',
        title: `Open ${relative}`,
        args,
        confirmDetail: isFolder
          ? `Open the folder ${relative} in your file manager`
          : `Open ${relative} in its usual app`,
        risk: 'safe',
        async run() {
          const failure = await shell.openPath(path)
          return failure
            ? { modelResult: `Could not open ${relative}: ${failure}`, madeProgress: false }
            : { modelResult: `Opened ${relative}${isFolder ? ' in the file manager' : ''}.` }
        }
      })
    }
  })
