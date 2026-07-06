import { exec } from 'node:child_process'
import type { WorkspaceToolFactory } from './types'
import { runGuardedTool } from './helpers'
import { classifyCommandRisk } from './permissions'

const COMMAND_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 1024 * 1024

interface ShellResult {
  stdout: string
  stderr: string
  code: number | string
}

/** run_command — execute a shell command in the workspace (requires approval). */
export const runCommandTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Run a shell command in the workspace directory and return its output. Use for builds, tests, git, etc.',
    params: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to execute.' }
      },
      required: ['command']
    } as const,
    handler: (args: { command: string }) =>
      runGuardedTool(ctx, {
        name: 'run_command',
        kind: 'command',
        title: `Run: ${args.command}`,
        confirmDetail: args.command,
        risk: classifyCommandRisk(args.command),
        async run() {
          const { stdout, stderr, code } = await runShell(
            args.command,
            ctx.workspaceRoot,
            ctx.signal
          )
          const combined =
            [stdout.trim(), stderr.trim() && `[stderr]\n${stderr.trim()}`]
              .filter(Boolean)
              .join('\n\n') || '(no output)'
          // No truncation here: `runGuardedTool`'s own MAX_MODEL_RESULT_CHARS
          // cap already applies to every guarded tool's result uniformly, the
          // same way `runReadTool`'s does for read tools. This tool used to
          // also truncate at a higher, redundant 10,000-char threshold — the
          // outer cap always fired first anyway, so that inner cap never
          // actually changed where output got cut off, it only made the
          // outer truncation note report a meaningless intermediate length
          // instead of the command's real output size.
          return { modelResult: `Exit code ${code}\n\n${combined}`, detail: `exit ${code}` }
        }
      })
  })

/** Run a command, always resolving with output + exit code (never rejecting). */
function runShell(command: string, cwd: string, signal?: AbortSignal): Promise<ShellResult> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, signal },
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
