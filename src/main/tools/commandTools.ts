import { exec } from 'node:child_process'
import type { ToolCall } from '@shared/tools.types'
import type { WorkspaceToolFactory } from './types'
import { runGuardedTool, runReadTool } from './helpers'
import { classifyCommandRisk } from './permissions'
import {
  checkCommandCompatibility,
  checkLongRunningServer,
  checkPrintOnly,
  describeEmptySearchResult
} from './commandGuidance'
import { isKnownMutatingCommand, isObservationalCommand } from './commandEffect'
import { availableTools } from './toolAvailability'

/** Default and caller-selectable ceiling for a shell command that does not exit. */
const COMMAND_TIMEOUT_MS = 60_000
const MAX_COMMAND_TIMEOUT_MS = 5 * 60_000
/** Kill a command that floods stdout or stderr before it consumes unbounded memory. */
const MAX_OUTPUT_BYTES = 1024 * 1024
/** Keep long command payloads out of transcript titles; approval details retain the full command. */
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
      'Run a shell command on this computer and return its output. It starts in the open project, or in the home folder in a plain chat, and is not confined to either. Write it for the system and shell named in "This computer". Use it for builds, tests and git, and for everyday tasks: finding files, opening things, disk space, installing programs, the clipboard. Not for answering a question that needs nothing from this computer, such as a fact, a sum or some writing: answer that directly.',
    params: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to execute.' },
        description: {
          type: 'string',
          description:
            'What the command does, in a few plain words for the person approving it: "List the largest files in Downloads".'
        },
        timeoutMs: {
          type: 'number',
          description: `Optional timeout in milliseconds. Defaults to ${COMMAND_TIMEOUT_MS}; capped at ${MAX_COMMAND_TIMEOUT_MS}.`
        }
      },
      required: ['command']
    } as const,
    handler: (args: { command: string; description?: string; timeoutMs?: number }) => {
      // Before approval, unlike the checks in `run()`: there is nothing to
      // approve, and asking the person to approve `echo Paris` is the worst
      // way to show them the model went wrong.
      const printOnly = checkPrintOnly(args.command)
      if (printOnly) {
        return runReadTool(ctx, {
          name: 'run_command',
          kind: 'command',
          title: commandTitle(args.command),
          args,
          run: () =>
            Promise.resolve({
              modelResult: printOnly,
              detail: 'not run: only prints text',
              madeProgress: false
            })
        })
      }
      return runGuardedTool(ctx, {
        name: 'run_command',
        kind: 'command',
        // The approval detail retains the whole command, but the transcript
        // title is replayed to the model. A here-string can otherwise turn a
        // one-line activity label into thousands of context characters.
        title: commandTitle(args.command),
        args,
        confirmDetail: describeCommand(
          args.command,
          ctx.commandShell,
          args.timeoutMs,
          args.description
        ),
        risk: classifyCommandRisk(args.command),
        async run() {
          // Checked before execution: a command that cannot work in this shell,
          // or whose pattern syntax is silently wrong for the tool it names,
          // costs a round trip and — worse — can return output the model reads
          // as evidence. See `commandGuidance.ts` for the incident behind this.
          const incompatible = checkCommandCompatibility(
            args.command,
            process.platform,
            ctx.commandShell
          )
          if (incompatible) {
            return {
              modelResult: incompatible,
              detail: 'not run: incompatible command',
              madeProgress: false
            }
          }

          // A server started here is killed with the call, so the command can
          // only ever spend its whole timeout and produce nothing.
          const server = checkLongRunningServer(
            args.command,
            availableTools(ctx, ['start_process']).length > 0
          )
          if (server) {
            return {
              modelResult: server,
              detail: 'not run: would not exit',
              madeProgress: false
            }
          }

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
          // An empty search result is ambiguous between "no matches" and "bad
          // pattern", and reading it as the former is what sent the driving
          // incident chasing elements that were present all along.
          const emptySearchNote =
            describeEmptySearchResult(
              args.command,
              combined,
              Boolean(terminated),
              availableTools(ctx, ['search_files', 'code_outline'])
            ) ?? ''
          // No truncation here: `runGuardedTool`'s own MAX_MODEL_RESULT_CHARS
          // cap already applies to every guarded tool's result uniformly, the
          // same way `runReadTool`'s does for read tools. This tool used to
          // also truncate at a higher, redundant 10,000-char threshold — the
          // outer cap always fired first anyway, so that inner cap never
          // actually changed where output got cut off, it only made the
          // outer truncation note report a meaningless intermediate length
          // instead of the command's real output size.
          return {
            modelResult: `${describeOutcome(terminated, code, timeoutMs, args.command)}\n\n${combined}${emptySearchNote}`,
            detail: terminated ? TERMINATION_DETAIL[terminated] : `exit ${code}`,
            // `madeProgress` stays as it was: a command that changed the
            // workspace must count as progress for the finish_goal evidence
            // gate even when Anodex cannot tell that it did.
            madeProgress: !isObservationalCommand(args.command),
            // The gathering streak asks a stricter question - is there positive
            // evidence something changed - so an unrecognised command stops
            // buying a free reset. See `recordOutcome`.
            provesChange: isKnownMutatingCommand(args.command)
          }
        }
      })
    }
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
/**
 * A command that asks the person for an administrator password in a window of
 * its own: pkexec on Linux, an elevated Start-Process on Windows, an AppleScript
 * "with administrator privileges" on macOS.
 */
const ASKS_FOR_PASSWORD = /\bpkexec\b|-Verb\s+RunAs\b|with administrator privileges/i

/**
 * Measured with an 8B in a plain chat: a pkexec install timed out while its
 * password window sat unanswered, the generic advice said to pass a larger
 * timeout, and the model retried with 60, 120, 180 and 240 seconds, opening a
 * fresh password window on the person's screen each time. A password window
 * that nobody answered, or one they closed, is the person's answer.
 */
function describePasswordOutcome(
  command: string,
  terminated: ShellResult['terminated'],
  code: number | string | null
): string | null {
  if (!ASKS_FOR_PASSWORD.test(command)) return null
  if (terminated === 'timeout') {
    return 'Timed out waiting for the person to type their password in the window it opened, and nobody did. Do not run it again: ask the person whether they want this, and tell them a password window will appear.'
  }
  // pkexec's code for a dismissed window. Its 127 ("not authorised") is left
  // out because a shell uses 127 for "command not found" as well.
  if (code === 126) {
    return `Exit code ${code}: the password window was closed or the password was refused, so the person did not approve this. Do not run it again unless they ask.`
  }
  return null
}

function describeOutcome(
  terminated: ShellResult['terminated'],
  code: number | string | null,
  timeoutMs: number,
  command = ''
): string {
  const password = describePasswordOutcome(command, terminated, code)
  if (password) return password
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

function describeCommand(
  command: string,
  shell?: string,
  timeoutMs?: number,
  purpose?: string
): string {
  // The plain-words purpose first: the person approving this may not read
  // shell, and the command itself stays right under it for anyone who does.
  const details = purpose?.trim() ? [purpose.trim(), command] : [command]
  if (shell) details.push(`Shell: ${shell}`)
  // Always shown, not only when the model named one. The person approving this
  // is agreeing to a command that will be killed part-way through if it runs
  // long, and the default is the case where that is most likely to surprise
  // them — it is the one they did not choose.
  details.push(`Timeout: ${normalizeTimeout(timeoutMs)} ms`)
  return details.join('\n\n')
}
