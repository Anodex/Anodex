import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, relative as relativePath, resolve, sep } from 'node:path'
import { shell } from 'electron'
import type { ToolFactory } from './types'
import { runGuardedTool, runReadTool } from './helpers'
import { expandHomeShorthand } from './homeShorthand'
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
 * Documents a browser would run as a page. Opened from the project they are the
 * person's own work (a game, a report); from anywhere else on the computer they
 * could be anything that was downloaded, so they stay inside the project.
 */
const RUNS_IN_A_BROWSER: ReadonlySet<string> = new Set(['.html', '.htm', '.svg'])

/**
 * Where a target points, and whether that is inside the open project.
 *
 * "Open my Downloads folder" used to need Downloads added as a project first,
 * which is ceremony for showing a folder. A full path or a home path (`~`,
 * `$HOME`: see `expandHomeShorthand`) now opens from anywhere on this computer, and so does a plain name when no project is
 * open, counted from the home folder. A relative path with a project open still
 * means the project, and may not climb out of it.
 */
export function resolveOpenTarget(
  target: string,
  workspaceRoot: string | null
): { path: string; inProject: boolean } {
  const expanded = expandHomeShorthand(target) ?? target
  if (isAbsolute(expanded)) {
    const path = resolve(expanded)
    const inside =
      workspaceRoot !== null &&
      (path === resolve(workspaceRoot) || path.startsWith(resolve(workspaceRoot) + sep))
    return { path, inProject: inside }
  }
  if (workspaceRoot) return { path: resolveInWorkspace(workspaceRoot, expanded), inProject: true }
  return { path: resolve(homedir(), expanded), inProject: false }
}

/** A path as a person reads it: inside the home folder, from `~`. */
function readablePath(path: string): string {
  const fromHome = relativePath(homedir(), path)
  return fromHome && !fromHome.startsWith('..') && !isAbsolute(fromHome)
    ? `~${sep}${fromHome}`
    : path
}

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
      'Open something for the person: an http(s) address in their browser (such as a local dev server), a folder in their file manager, or a document (PDF, image, text, office file) in its usual app. Folders and documents can be anywhere on this computer: a project-relative path, a full path, or a ~ path such as ~/Downloads. Never opens programs or scripts.',
    params: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'An http(s) address, or a path to a folder or document: project-relative, full, or starting with ~.'
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

      let path: string
      let inProject: boolean
      try {
        ;({ path, inProject } = resolveOpenTarget(target, ctx.workspaceRoot))
      } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error))
      }
      const relative =
        inProject && ctx.workspaceRoot
          ? toWorkspaceRelative(ctx.workspaceRoot, path)
          : readablePath(path)
      let isFolder: boolean
      try {
        isFolder = (await stat(path)).isDirectory()
      } catch {
        return refuse(`${relative} does not exist.`)
      }
      if (!isFolder && !inProject && RUNS_IN_A_BROWSER.has(extname(path).toLowerCase())) {
        return refuse(
          `Anodex opens web pages and SVGs only from the open project, since a browser runs them. ${relative} is outside it.`
        )
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
