import { mkdir, rmdir } from 'node:fs/promises'
import type { WorkspaceToolFactory } from './types'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import { runGuardedTool } from './helpers'

/** create_directory — make a folder (and any missing parents) in the workspace. */
export const createDirectoryTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Create a directory inside the workspace, including any missing parent directories. Safe and does not require approval.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to the workspace root.' }
      },
      required: ['path']
    } as const,
    handler: (args: { path: string }) =>
      runGuardedTool(ctx, {
        name: 'create_directory',
        kind: 'write',
        title: `Create ${args.path}`,
        confirmDetail: `Create directory ${args.path}`,
        risk: 'trivial',
        async run() {
          const dir = resolveInWorkspace(ctx.workspaceRoot, args.path)
          await mkdir(dir, { recursive: true })
          return {
            modelResult: `Created directory ${toWorkspaceRelative(ctx.workspaceRoot, dir)}.`,
            detail: 'created'
          }
        }
      })
  })

/** delete_directory — remove an empty directory from the workspace. */
export const deleteDirectoryTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Delete an empty directory inside the workspace. Fails if the directory is not empty.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to the workspace root.' }
      },
      required: ['path']
    } as const,
    handler: (args: { path: string }) =>
      runGuardedTool(ctx, {
        name: 'delete_directory',
        kind: 'write',
        title: `Delete ${args.path}`,
        confirmDetail: `Delete empty directory ${args.path}`,
        risk: 'sensitive',
        async run() {
          const dir = resolveInWorkspace(ctx.workspaceRoot, args.path)
          await rmdir(dir)
          return {
            modelResult: `Deleted directory ${toWorkspaceRelative(ctx.workspaceRoot, dir)}.`,
            detail: 'deleted'
          }
        }
      })
  })
