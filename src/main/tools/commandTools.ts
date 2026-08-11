import { exec } from 'node:child_process'
import type { ToolCall } from '@shared/tools.types'
import type { WorkspaceToolFactory } from './types'
import { runGuardedTool } from './helpers'
import { classifyCommandRisk } from './permissions'

const COMMAND_TIMEOUT_MS = 60_000
const MAX_COMMAND_TIMEOUT_MS = 5 * 60_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_COMMAND_TITLE_CHARS = 360
const COMMAND_TITLE_OMISSION = ' [long command payload omitted]'

/**
 * Command execution is approval-gated, but not OS-sandboxed: the shell starts
 * in the workspace directory, yet can access anything the user's account can
 * access. File tools enforce path confinement separately; command safety comes
 * from risk classification plus user approval.
 */
interface ShellResult {
  stdout: string
  stderr: string
  code: number | string | null
  /**
   * Why the process ended, when it was not the command exiting on its own.
   *
   * Node reports all three of these through the same `error` argument as an
   * ordinary failure, and for a killed process `error.code` is `null` — so a
   * command that hit the timeout used to be handed to the model as
   * "Exit code null", with nothing to say it had been killed or why. The most
   * likely thing a model does with that is run the identical command again and
   * spend the timeout a second time.
   */
  terminated?: 'timeout' | 'output-limit' | 'stopped'
}

/** run_command — execute a shell command in the workspace (requires approval). */
export const runCommandTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Run a real local shell command with the workspace as its starting directory and return its output. Unlike file tools, the shell is not confined to the workspace. Use for builds, tests, git, etc.',
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
        // The approval detail retains the whole command, but the transcript
        // title is replayed to the model. A here-string can otherwise turn a
        // one-line activity label into thousands of context characters.
        title: commandTitle(args.command),
        args,
        confirmDetail: describeCommand(args.command, ctx.commandShell, args.timeoutMs),
        risk: classifyCommandRisk(args.command),
        async run() {
          const timeoutMs = normalizeTimeout(args.timeoutMs)
          const { stdout, stderr, code, terminated } = await runShell(
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
          return {
            modelResult: `${describeOutcome(terminated, code, timeoutMs)}\n\n${combined}`,
            detail: terminated ? TERMINATION_DETAIL[terminated] : `exit ${code}`
          }
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
 *
 * A run that was killed — timed out, drowned in its own output, or stopped —
 * is in the same category and also returns `null`, because its `detail` is a
 * reason rather than `exit <code>`. It matters: those runs used to arrive here
 * as `exit null`, match as "not zero", and be recorded as a *failed*
 * verification. "The tests failed" and "the tests never finished" are different
 * claims, and only one of them was supported by what happened.
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

/**
 * What the model is told a command did, leading with the reason it stopped
 * rather than a raw exit code that would be `null` for anything killed.
 */
function describeOutcome(
  terminated: ShellResult['terminated'],
  code: number | string | null,
  timeoutMs: number
): string {
  if (terminated === 'timeout') {
    return `Timed out after ${timeoutMs} ms and was killed. Re-running it unchanged will time out again — narrow the command, or pass a larger timeoutMs (up to ${MAX_COMMAND_TIMEOUT_MS}). Output up to that point:`
  }
  if (terminated === 'output-limit') {
    return `Produced more than ${Math.floor(MAX_OUTPUT_BYTES / 1024)} KB of output and was killed. Re-run it with the output filtered or redirected to a file. Output up to that point:`
  }
  if (terminated === 'stopped') return 'Stopped before it finished. Output up to that point:'
  return `Exit code ${code}`
}

/** `ToolCall.detail` for a run that never reached an exit code of its own. */
const TERMINATION_DETAIL: Record<NonNullable<ShellResult['terminated']>, string> = {
  timeout: 'timed out',
  'output-limit': 'output limit',
  stopped: 'stopped'
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
        if (!error) {
          resolve({ stdout, stderr, code: 0 })
          return
        }
        const errno = error as NodeJS.ErrnoException & { killed?: boolean }
        // Ordered by specificity. An abort and a timeout both surface as a
        // killed process, so the caller's own signal is checked first;
        // `maxBuffer` overflow is the one kill that carries a real `code`.
        const terminated: ShellResult['terminated'] = signal?.aborted
          ? 'stopped'
          : errno.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? 'output-limit'
            : errno.killed
              ? 'timeout'
              : undefined
        // `code` is `null` for anything killed by a signal, so it is only
        // meaningful when the command exited on its own.
        const code = terminated ? null : (errno.code ?? 1)
        resolve({ stdout, stderr, code, terminated })
      }
    )
  })
}

function normalizeTimeout(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return COMMAND_TIMEOUT_MS
  return Math.max(1_000, Math.min(Math.floor(timeoutMs), MAX_COMMAND_TIMEOUT_MS))
}

function commandTitle(command: string): string {
  const normalized = command.replace(/\s+/g, ' ').trim()
  const prefix = 'Run: '
  const maxCommandChars =
    MAX_COMMAND_TITLE_CHARS - prefix.length - COMMAND_TITLE_OMISSION.length - 1
  if (normalized.length <= maxCommandChars) return `${prefix}${normalized}`
  return `${prefix}${normalized.slice(0, maxCommandChars).trimEnd()}…${COMMAND_TITLE_OMISSION}`
}

function describeCommand(command: string, shell?: string, timeoutMs?: number): string {
  const details = [command]
  if (shell) details.push(`Shell: ${shell}`)
  // Always shown, not only when the model named one. The person approving this
  // is agreeing to a command that will be killed part-way through if it runs
  // long, and the default is the case where that is most likely to surprise
  // them — it is the one they did not choose.
  details.push(`Timeout: ${normalizeTimeout(timeoutMs)} ms`)
  return details.join('\n\n')
}
