import { existsSync } from 'node:fs'
import { app, shell } from 'electron'
import { formatBytes } from '@shared/format'
import type { ToolFactory } from './types'
import { runGuardedTool, runReadTool } from './helpers'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import {
  findCleanupCandidates,
  liveCleanupEnv,
  sizeOf,
  type CleanupCandidate
} from '../cleanup/cleanupCandidates'

function downloadsFolder(): string | null {
  try {
    return app.getPath('downloads')
  } catch {
    return null
  }
}

function sizeLabel(bytes: number, atLeast: boolean): string {
  return `${atLeast ? 'at least ' : ''}${formatBytes(bytes)}`
}

/**
 * find_cleanup — what can safely go, and how much room it would free.
 *
 * Read-only, so it never asks. It looks only where contents are disposable by
 * design (package caches, old temp files, year-old downloads); see
 * `findCleanupCandidates`.
 */
export const findCleanupTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Find things that can safely be cleared to free disk space (package caches, old temporary files, downloads older than a year), with their sizes. Read-only. Clear them with move_to_trash using the ids it returns.',
    params: { type: 'object', properties: {} } as const,
    handler: () =>
      runReadTool(ctx, {
        name: 'find_cleanup',
        kind: 'read',
        title: 'Look for things to clean up',
        async run() {
          const candidates = await findCleanupCandidates(liveCleanupEnv(downloadsFolder()))
          if (candidates.length === 0) {
            return { modelResult: 'Nothing found that is safe to clear.' }
          }
          const total = candidates.reduce((sum, c) => sum + c.sizeBytes, 0)
          return {
            modelResult: [
              `Found ${formatBytes(total)} that can be cleared:`,
              ...candidates.map(
                (c) =>
                  `- ${c.id}: ${c.label}, ${sizeLabel(c.sizeBytes, c.atLeast)} (${c.where}). ${c.why}`
              ),
              'Clearing moves them to the Trash, so they can be put back.'
            ].join('\n')
          }
        }
      })
  })

interface TrashItem {
  id: string
  label: string
  detail: string
  paths: string[]
  sizeBytes: number
  atLeast: boolean
}

/**
 * move_to_trash — move cleanup items, or files in the open project, to the
 * Trash or Recycle Bin.
 *
 * Never deletes anything for good: everything it removes can be put back from
 * the Trash. It only accepts what find_cleanup offers (by id) or paths inside
 * the open project, so it cannot be pointed at the rest of the disk. Shows a
 * list to tick in Ask and Edits mode and goes ahead in Untethered.
 */
export const moveToTrashTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Move items to the Trash (recoverable, never a permanent delete): cleanup ids from find_cleanup, or paths of files and folders inside the open project.',
    params: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'find_cleanup ids such as "npm-cache", or project-relative paths.'
        }
      },
      required: ['items']
    } as const,
    handler: async (args: { items: string[] }) => {
      const wanted = [...new Set((args.items ?? []).map((item) => item.trim()).filter(Boolean))]
      const resolved = await resolveItems(wanted, ctx.workspaceRoot)
      if ('error' in resolved || resolved.items.length === 0) {
        return runReadTool(ctx, {
          name: 'move_to_trash',
          kind: 'read',
          title: 'Move to Trash',
          args,
          run: () =>
            Promise.resolve({
              modelResult:
                'error' in resolved ? resolved.error : 'Nothing to move: no item was named.',
              madeProgress: false
            })
        })
      }
      const { items } = resolved
      const total = items.reduce((sum, item) => sum + item.sizeBytes, 0)
      return runGuardedTool(ctx, {
        name: 'move_to_trash',
        kind: 'write',
        title: `Move ${formatBytes(total)} to the Trash`,
        args,
        confirmDetail:
          'Untick anything you want to keep. Everything moved can be put back from the Trash.',
        risk: 'sensitive',
        confirmChoices: items.map((item) => ({
          id: item.id,
          label: item.label,
          detail: item.detail,
          size: sizeLabel(item.sizeBytes, item.atLeast)
        })),
        async run(_progress, confirmation) {
          const chosen = confirmation?.chosenIds
            ? items.filter((item) => confirmation.chosenIds?.includes(item.id))
            : items
          if (chosen.length === 0) {
            return {
              modelResult: 'Nothing was moved: every item was unticked.',
              madeProgress: false
            }
          }
          const moved: TrashItem[] = []
          const failed: string[] = []
          for (const item of chosen) {
            try {
              for (const path of item.paths) {
                if (existsSync(path)) await shell.trashItem(path)
              }
              moved.push(item)
            } catch (error) {
              failed.push(
                `${item.label}: ${error instanceof Error ? error.message : String(error)}`
              )
            }
          }
          const freed = moved.reduce((sum, item) => sum + item.sizeBytes, 0)
          return {
            modelResult: [
              moved.length
                ? `Moved to the Trash (${formatBytes(freed)}): ${moved.map((item) => item.label).join(', ')}. It can be put back from the Trash; emptying the Trash frees the space.`
                : 'Nothing was moved.',
              failed.length
                ? `Could not move: ${failed.join('; ')}. Nothing was deleted instead.`
                : ''
            ]
              .filter(Boolean)
              .join('\n'),
            detail: `${formatBytes(freed)} to Trash`
          }
        }
      })
    }
  })

async function resolveItems(
  wanted: string[],
  workspaceRoot: string | null
): Promise<{ items: TrashItem[] } | { error: string }> {
  let candidates: CleanupCandidate[] | null = null
  const items: TrashItem[] = []
  for (const name of wanted) {
    if (/^[a-z]+(-[a-z]+)+$/.test(name)) {
      candidates ??= await findCleanupCandidates(liveCleanupEnv(downloadsFolder()))
      const candidate = candidates.find((c) => c.id === name)
      if (!candidate) {
        return {
          error: `"${name}" is not something find_cleanup offers right now. Run find_cleanup first.`
        }
      }
      items.push({
        id: candidate.id,
        label: candidate.label,
        detail: candidate.where,
        paths: candidate.paths,
        sizeBytes: candidate.sizeBytes,
        atLeast: candidate.atLeast
      })
      continue
    }
    if (!workspaceRoot) {
      return {
        error: `"${name}" is not a cleanup id, and only files inside an open project can be moved by path.`
      }
    }
    let path: string
    try {
      path = resolveInWorkspace(workspaceRoot, name)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
    const relative = toWorkspaceRelative(workspaceRoot, path)
    if (relative === '.')
      return { error: 'That is the whole project; name what inside it should go.' }
    const size = await sizeOf(path)
    if (!size) return { error: `${relative} does not exist.` }
    items.push({
      id: `path:${relative}`,
      label: relative,
      detail: 'in this project',
      paths: [path],
      sizeBytes: size.bytes,
      atLeast: size.truncated
    })
  }
  return { items }
}
