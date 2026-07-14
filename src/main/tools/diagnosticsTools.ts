import { exec } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { WorkspaceToolFactory } from './types'
import { resolveInWorkspace } from './workspace'
import { runGuardedTool } from './helpers'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const OUTPUT_TAIL_CHARS = 3000
const FAILURE_HINT_LIMIT = 12

type ProjectCheckKind = 'test' | 'typecheck' | 'lint' | 'build' | 'custom'

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
        risk: 'sensitive',
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

async function resolveCheckCommand(
  workspaceRoot: string,
  kind: ProjectCheckKind,
  override?: string
): Promise<string> {
  const explicit = override?.trim()
  if (explicit) return explicit
  if (kind === 'custom') throw new Error('command is required for a custom project check.')

  const packageJson = await readPackageJson(workspaceRoot)
  const scripts = packageJson?.scripts ?? {}
  if (scripts[kind]) return kind === 'test' ? 'npm test' : `npm run ${kind}`

  const fallbacks: Record<Exclude<ProjectCheckKind, 'custom'>, string> = {
    test: 'npm test',
    typecheck: 'npm run typecheck',
    lint: 'npm run lint',
    build: 'npm run build'
  }
  return fallbacks[kind]
}

async function readPackageJson(
  workspaceRoot: string
): Promise<{ scripts?: Record<string, string> } | null> {
  try {
    const path = resolveInWorkspace(workspaceRoot, 'package.json')
    return JSON.parse(await readFile(path, 'utf-8')) as { scripts?: Record<string, string> }
  } catch {
    return null
  }
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

function inferKind(command: string): ProjectCheckKind {
  if (/\b(typecheck|tsc)\b/i.test(command)) return 'typecheck'
  if (/\blint\b/i.test(command)) return 'lint'
  if (/\bbuild\b/i.test(command)) return 'build'
  if (/\b(test|vitest|jest|playwright)\b/i.test(command)) return 'test'
  return 'custom'
}

function extractFailureHints(output: string): string[] {
  if (!output.trim()) return []
  const hintPatterns = [
    /\b(error|failed|failure|fatal|exception|traceback)\b/i,
    /\b\w+\.(?:ts|tsx|js|jsx|py|rs|go|java|css|md):\d+:\d+/i,
    /^\s*[✖×]\s+/
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
