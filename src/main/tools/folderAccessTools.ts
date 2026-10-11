import { mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import { app } from 'electron'
import type { ToolFactory } from './types'
import { runGuardedTool, runReadTool } from './helpers'
import { resolveRequestedFolder, sameFolder, type KnownFolders } from './folderAccess'
import { projectStore } from '../projects/ProjectStore'

/**
 * request_folder_access — work in a folder the person names, outside any open
 * project.
 *
 * File and command tools only ever exist inside a project, and a plain chat
 * has none, so "set up a Minecraft server on my Desktop" had nowhere to put a
 * single file. Granting a folder makes it a project (or reuses the project
 * that already has it), which brings every existing guard along: edits stay
 * inside that folder, each one has a restore point, and processes it starts
 * belong to it. The reply then carries on there; see `switchProject`.
 *
 * Asks first in Ask and Edits modes and goes ahead in Untethered (`sensitive`
 * risk). Too-broad folders (a drive, the home folder, system folders) are
 * refused before anything is asked.
 */
export const requestFolderAccessTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Ask to work in a folder on this computer, such as "Desktop/minecraft-server" or "~/projects/site", when the person wants files created or changed outside any open project. Once allowed, the folder becomes a project and this reply continues there with file and command tools. The folder is created if it does not exist.',
    params: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'The folder: an absolute path, ~/…, or starting with Desktop, Documents or Downloads.'
        },
        purpose: {
          type: 'string',
          description: 'One short phrase saying what the folder is for, shown to the person.'
        }
      },
      required: ['path']
    } as const,
    handler: (args: { path: string; purpose?: string }) => {
      const resolved = resolveRequestedFolder(args.path, knownFolders())
      if (!resolved.ok) {
        return runReadTool(ctx, {
          name: 'request_folder_access',
          kind: 'read',
          title: `Use folder ${args.path}`,
          args,
          run: () => Promise.resolve({ modelResult: resolved.reason, madeProgress: false })
        })
      }
      const folder = resolved.path
      const existing = findProject(folder)
      const name = existing?.name ?? basename(folder)
      return runGuardedTool(ctx, {
        name: 'request_folder_access',
        kind: 'write',
        title: `Use folder ${folder}`,
        args,
        confirmDetail: [
          args.purpose?.trim()
            ? `To ${args.purpose.trim()}, Anodex wants to work in:`
            : 'Anodex wants to work in:',
          folder,
          existing
            ? `This is your project "${name}". This chat moves into it.`
            : `It will be added as a project called "${name}". Anodex can only edit files inside it, and every edit has a restore point.`
        ].join('\n'),
        risk: 'sensitive',
        async run() {
          await mkdir(folder, { recursive: true })
          const project = findProject(folder) ?? projectStore.create({ name, folderPath: folder })
          ctx.switchProject?.(project.id)
          // The tools this cycle was built with have no file access; ending it
          // here is what lets the next one start with them. See
          // `runBoundedChatGeneration`.
          ctx.abortGeneration?.()
          return {
            modelResult: `Folder access granted: ${folder} is the project "${project.name}". This reply continues there with file and command tools.`,
            detail: project.name
          }
        }
      })
    }
  })

function findProject(folder: string): { id: string; name: string } | undefined {
  return projectStore
    .getState()
    .projects.find((project) => !project.archived && sameFolder(project.folderPath, folder))
}

function knownFolders(): KnownFolders {
  const read = (name: 'desktop' | 'documents' | 'downloads' | 'home'): string | undefined => {
    try {
      return app.getPath(name)
    } catch {
      return undefined
    }
  }
  return {
    home: read('home'),
    desktop: read('desktop'),
    documents: read('documents'),
    downloads: read('downloads')
  }
}
