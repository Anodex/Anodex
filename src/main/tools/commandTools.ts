import { exec } from 'node:child_process'
import type { ToolCall } from '@shared/tools.types'
import type { WorkspaceToolFactory } from './types'
import { runGuardedTool } from './helpers'
import { classifyCommandRisk } from './permissions'

const COMMAND_TIMEOUT_MS = 60_000
const MAX_COMMAND_TIMEOUT_MS = 5 * 60_000
const MAX_OUTPUT_BYTES = 1024 * 1024

/**
 * Command execution is approval-gated, but not OS-sandboxed: the shell starts
 * in the workspace directory, yet can access anything the user's account can
 * access. File tools enforce path confinement separately; command safety comes
 * from risk classification plus user approval.
 */
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
        command: { type: 'string', description: 'The command line to execute.' },
        timeoutMs: {
          type: 'number',
          description: `Optional timeout in milliseconds. Defaults to ${COMMAND_TIMEOUT_MS}; capped at ${MAX_COMMAND_TIMEOUT_MS}.`
        }
      },
      required: ['command']
    } as const,
    handler: (args: { command: string; timeoutMs?: number }) =>
      runGuardedTool(ctx, {
        name: 'run_command',
        kind: 'command',
        title: `Run: ${args.command}`,
        args,
        confirmDetail: describeCommand(args.command, ctx.commandShell, args.timeoutMs),
        risk: classifyCommandRisk(args.command),
        async run() {
          const timeoutMs = normalizeTimeout(args.timeoutMs)
          const { stdout, stderr, code } = await runShell(
            args.command,
            ctx.workspaceRoot,
            timeoutMs,
            ctx.commandShell,
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

/**
 * Extract a pass/fail verification result from a completed `run_command`
 * call, for `ProjectRecallEvent`'s `verification` field (see
 * `runGeneration.ts`). Parses this tool's own fixed, Anodex-authored
 * title/detail format (`Run: <command>` / `exit <code>`, both set above and
 * in `helpers.ts`'s `runGuardedTool`) rather than model-generated free text —
 * safe, controlled string parsing, not the kind this project treats with
 * suspicion elsewhere. Returns `null` for anything other than a
 * successfully *executed* run_command call: a non-zero exit code still
 * executed (that's a failed verification, worth recording), but a
 * denied/errored call never reached a real exit code at all.
 */
export function parseRunCommandVerification(
  call: Pick<ToolCall, 'name' | 'status' | 'title' | 'detail'>
): { command: string; status: 'passed' | 'failed' } | null {
  if (call.name !== 'run_command' || call.status !== 'success') return null
  const command = call.title.startsWith('Run: ') ? call.title.slice('Run: '.length) : null
  const exitMatch = call.detail?.match(/^exit (.+)$/)
  if (!command || !exitMatch) return null
  return { command, status: exitMatch[1] === '0' ? 'passed' : 'failed' }
}

/** Run a command, always resolving with output + exit code (never rejecting). */
function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  shell?: string,
  signal?: AbortSignal
): Promise<ShellResult> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, shell, signal },
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

function normalizeTimeout(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return COMMAND_TIMEOUT_MS
  return Math.max(1_000, Math.min(Math.floor(timeoutMs), MAX_COMMAND_TIMEOUT_MS))
}

function describeCommand(command: string, shell?: string, timeoutMs?: number): string {
  const details = [command]
  if (shell) details.push(`Shell: ${shell}`)
  if (timeoutMs !== undefined) details.push(`Timeout: ${normalizeTimeout(timeoutMs)} ms`)
  return details.join('\n\n')
}
