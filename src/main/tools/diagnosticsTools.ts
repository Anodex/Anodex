import { exec } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import type { WorkspaceToolFactory } from './types'
import { runGuardedTool } from './helpers'
import { classifyCommandRisk } from './permissions'
import {
  describeUnresolvedCheck,
  detectToolchain,
  type ToolchainCheckKind
} from './projectToolchain'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const OUTPUT_TAIL_CHARS = 3000
const FAILURE_HINT_LIMIT = 12

/**
 * This tool's kinds: every check a toolchain can have a conventional command
 * for, plus `custom`, where the caller supplies the command itself. Derived
 * from `ToolchainCheckKind` rather than restated, so the two cannot drift.
 */
type ProjectCheckKind = ToolchainCheckKind | 'custom'

interface ProjectCheckResult {
  kind: ProjectCheckKind
  command: string
  status: 'passed' | 'failed'
  exitCode: number | string
  durationMs: number
  failureHints: string[]
  outputTail: string
}

/** run_project_check — structured wrapper around common verification commands. */
export const runProjectCheckTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Run a common project check (test, typecheck, lint, build, or custom command) and return structured pass/fail diagnostics instead of an unparsed shell blob.',
    params: {
      type: 'object',
      properties: {
        kind: {
          enum: ['test', 'typecheck', 'lint', 'build', 'custom'],
          description: 'Which check to run. Use custom only when providing command.'
        },
        command: {
          type: 'string',
          description: 'Command to run for kind=custom, or an explicit override for a known check.'
        },
        timeoutMs: {
          type: 'number',
          description: `Optional timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}; capped at ${MAX_TIMEOUT_MS}.`
        }
      },
      required: ['kind']
    } as const,
    handler: (args: { kind: ProjectCheckKind; command?: string; timeoutMs?: number }) =>
      runGuardedTool(ctx, {
        name: 'run_project_check',
        kind: 'command',
        title: `Check: ${args.kind}`,
        args,
        confirmDetail: describeCheck(args.kind, args.command),
        risk: args.command?.trim() ? classifyCommandRisk(args.command) : 'sensitive',
        async run() {
          const command = await resolveCheckCommand(ctx.workspaceRoot, args.kind, args.command)
          const result = await runCheck(
            command,
            ctx.workspaceRoot,
            normalizeTimeout(args.timeoutMs),
            ctx.commandShell,
            ctx.signal
          )
          return {
            modelResult: JSON.stringify(result, null, 2),
            detail: `${result.status} · exit ${result.exitCode}`
          }
        }
      })
  })

/**
 * Work out what to actually run for a check.
 *
 * This used to look for npm scripts and then fall back to `npm test` /
 * `npm run <kind>` unconditionally, so every check in a Python, Rust, Go, C#,
 * or Java project ran npm in a directory npm knows nothing about. Verification
 * is how Anodex stops itself claiming unproven fixes, so a verification tool
 * that only worked for one ecosystem removed that safeguard everywhere else.
 * Detection now covers the common toolchains — see `projectToolchain.ts`.
 */
async function resolveCheckCommand(
  workspaceRoot: string,
  kind: ProjectCheckKind,
  override?: string
): Promise<string> {
  const explicit = override?.trim()
  if (explicit) return explicit
  if (kind === 'custom') throw new Error('command is required for a custom project check.')

  const entries = await readdir(workspaceRoot).catch(() => [] as string[])
  const detection = await detectToolchain(workspaceRoot, entries)
  const command = detection.chosen?.commands[kind]
  // An honest failure naming what was detected beats a confidently wrong
  // command that fails with an unrelated packaging error.
  if (!command) throw new Error(describeUnresolvedCheck(kind, detection))
  return command
}

function runCheck(
  command: string,
  cwd: string,
  timeoutMs: number,
  shell?: string,
  signal?: AbortSignal
): Promise<ProjectCheckResult> {
  const start = Date.now()
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
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
        resolve({
          kind: inferKind(command),
          command,
          status: code === 0 ? 'passed' : 'failed',
          exitCode: code,
          durationMs: Date.now() - start,
          failureHints: extractFailureHints(output),
          outputTail: tail(output || '(no output)', OUTPUT_TAIL_CHARS)
        })
      }
    )
  })
}

/**
 * Label a command by what kind of check it is. Covers the common tools across
 * ecosystems, not just the JavaScript ones — a Python project's `mypy` is a
 * type check and its `ruff` is a linter, and reporting either as "custom"
 * makes the structured result less useful than the raw output it replaced.
 *
 * Order matters, because several commands legitimately contain more than one
 * of these words. Linters are named most specifically, so they match first:
 * `ruff check .` is a lint run, but a type-check rule matching the bare word
 * "check" would otherwise claim it. `cargo check` then falls through to
 * typecheck, which is what it is.
 */
function inferKind(command: string): ProjectCheckKind {
  if (/\b(lint|clippy|ruff|pylint|flake8|eslint|biome|vet|gofmt)\b/i.test(command)) return 'lint'
  if (/\b(typecheck|type-check|tsc|mypy|pyright|check)\b/i.test(command)) return 'typecheck'
  if (/\b(build|compile|package|assemble)\b/i.test(command)) return 'build'
  if (/\b(test|vitest|jest|mocha|pytest|ctest|rspec|phpunit|xunit|nunit)\b/i.test(command)) {
    return 'test'
  }
  return 'custom'
}

function extractFailureHints(output: string): string[] {
  if (!output.trim()) return []
  const hintPatterns = [
    /\b(error|failed|failure|fatal|exception|traceback|panic|assert)\b/i,
    // A `file:line:col` reference, in any language Anodex might be pointed at.
    // The extension list was JS/Python/Rust/Go/Java only, so a C++, C#, Swift,
    // Kotlin, Ruby, or shader compiler error carrying no "error" keyword was
    // dropped from the hints entirely.
    /\b[\w-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|kts|cs|fs|swift|m|mm|c|cc|cpp|cxx|h|hh|hpp|rb|php|lua|dart|ex|exs|hs|scala|clj|zig|nim|gd|sh|sql|css|scss|html|vue|svelte|json|ya?ml|toml|md):\d+(?::\d+)?/i,
    /^\s*[✖×✗]\s+/
  ]
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && hintPatterns.some((pattern) => pattern.test(line)))
    .slice(0, FAILURE_HINT_LIMIT)
}

function normalizeTimeout(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS
  return Math.max(1_000, Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS))
}

function describeCheck(kind: ProjectCheckKind, command?: string): string {
  const explicit = command?.trim()
  return explicit ? `${kind}: ${explicit}` : `Run the project's ${kind} check.`
}

function tail(text: string, maxChars: number): string {
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text
}
