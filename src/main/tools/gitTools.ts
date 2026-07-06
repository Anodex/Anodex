import { exec } from 'node:child_process'
import type { WorkspaceToolFactory } from './types'
import { resolveInWorkspace } from './workspace'
import { runReadTool } from './helpers'

const GIT_TIMEOUT_MS = 30_000

interface GitResult {
  stdout: string
  stderr: string
  code: number | string
}

/** git_status — show the working tree status of the workspace repo. */
export const gitStatusTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Run git status --short in the workspace. Returns empty if the workspace is not a git repository.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional subdirectory to run git status in.' }
      }
    } as const,
    handler: (args: { path?: string }) =>
      runReadTool(ctx, {
        name: 'git_status',
        kind: 'read',
        title: 'Git status',
        async run() {
          const cwd = resolveInWorkspace(ctx.workspaceRoot, args.path?.trim() || '.')
          const { stdout, stderr, code } = await runGit(['status', '--short'], cwd, ctx.signal)
          if (code !== 0) {
            return {
              modelResult: `Git status failed (exit ${code}): ${stderr.trim() || stdout.trim() || 'unknown error'}`,
              detail: `exit ${code}`
            }
          }
          const output = stdout.trim() || '(no changes)'
          return {
            modelResult: output,
            detail: `${output.split('\n').length} line(s)`
          }
        }
      })
  })

/** git_diff — show changes in the workspace repo. */
export const gitDiffTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Run git diff in the workspace. Set staged to true to see staged changes. Returns empty if there are no changes or if the workspace is not a git repository.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional subdirectory to run git diff in.' },
        staged: { type: 'boolean', description: 'Show staged changes instead of unstaged.' }
      }
    } as const,
    handler: (args: { path?: string; staged?: boolean }) =>
      runReadTool(ctx, {
        name: 'git_diff',
        kind: 'read',
        title: args.staged ? 'Git diff --staged' : 'Git diff',
        async run() {
          const cwd = resolveInWorkspace(ctx.workspaceRoot, args.path?.trim() || '.')
          const flags = args.staged ? ['diff', '--staged'] : ['diff']
          const { stdout, stderr, code } = await runGit(flags, cwd, ctx.signal)
          if (code !== 0) {
            return {
              modelResult: `Git diff failed (exit ${code}): ${stderr.trim() || stdout.trim() || 'unknown error'}`,
              detail: `exit ${code}`
            }
          }
          const output = stdout.trim() || '(no changes)'
          // No truncation here: `runReadTool`'s own MAX_MODEL_RESULT_CHARS cap
          // already applies uniformly to every read tool's result (same
          // reasoning as the read_file/run_command fixes — this tool's own,
          // larger, redundant cap never actually changed the truncation
          // point, it just produced a misleading note when both fired).
          return {
            modelResult: output,
            detail: `${output.split('\n').length} line(s)`
          }
        }
      })
  })

/** Run a git subcommand, always resolving with output + exit code. */
function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult> {
  return new Promise((resolve) => {
    exec(
      `git ${args.join(' ')}`,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, signal },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException).code !== 'undefined'
            ? ((error as NodeJS.ErrnoException).code as number | string)
            : error
              ? 1
              : 0
        resolve({ stdout, stderr, code })
      }
    )
  })
}
