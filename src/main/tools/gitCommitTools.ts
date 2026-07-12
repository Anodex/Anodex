import { exec } from 'node:child_process'
import type { WorkspaceToolFactory } from './types'
import { resolveInWorkspace } from './workspace'
import { runReadTool } from './helpers'

const GIT_TIMEOUT_MS = 30_000
const MAX_DIFF_STAT_CHARS = 4000

interface GitCommitSummaryArgs {
  staged?: boolean
  path?: string
}

interface GitCommandResult {
  stdout: string
  stderr: string
  code: number | string
}

/** git_commit_summary — summarize current changes and propose a commit message. */
export const gitCommitSummaryTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Inspect git status/diff stats and propose a concise conventional commit message. Use before the user asks to commit or wants a commit-message draft.',
    params: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Summarize staged changes only.' },
        path: { type: 'string', description: 'Optional subdirectory to inspect.' }
      }
    } as const,
    handler: (args: GitCommitSummaryArgs) =>
      runReadTool(ctx, {
        name: 'git_commit_summary',
        kind: 'read',
        title: args.staged ? 'Draft commit message for staged changes' : 'Draft commit message',
        async run() {
          const cwd = resolveInWorkspace(ctx.workspaceRoot, args.path?.trim() || '.')
          const status = await runGit('status --short', cwd, ctx.signal)
          if (status.code !== 0) return gitError('status', status)

          const diffNameFlag = args.staged ? 'diff --staged --name-only' : 'diff --name-only'
          const diffStatFlag = args.staged ? 'diff --staged --stat' : 'diff --stat'
          const names = await runGit(diffNameFlag, cwd, ctx.signal)
          const stat = await runGit(diffStatFlag, cwd, ctx.signal)
          if (names.code !== 0) return gitError('diff --name-only', names)
          if (stat.code !== 0) return gitError('diff --stat', stat)

          const changedFiles = names.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
          if (changedFiles.length === 0) {
            return { modelResult: 'No changes found for a commit summary.', detail: 'no changes' }
          }

          const message = suggestCommitMessage(changedFiles)
          const body = [
            'Suggested commit message:',
            message,
            '',
            `Files changed: ${changedFiles.length}`,
            ...changedFiles.map((file) => `- ${file}`),
            '',
            'Diff stat:',
            truncate(stat.stdout.trim() || '(no diff stat)', MAX_DIFF_STAT_CHARS),
            '',
            'Working tree status:',
            status.stdout.trim() || '(clean)'
          ].join('\n')

          return { modelResult: body, detail: message }
        }
      })
  })

function suggestCommitMessage(files: string[]): string {
  const type = inferCommitType(files)
  const subject = inferSubject(type, files)
  return `${type}: ${subject}`
}

function inferCommitType(files: string[]): string {
  if (files.every((file) => /(^|\/)(README|CHANGELOG|docs\/)|\.(md|mdx|rst)$/i.test(file))) {
    return 'docs'
  }
  if (
    files.every((file) => /(^|\/)(__tests__|tests?|e2e)(\/|$)|\.(test|spec)\.[tj]sx?$/i.test(file))
  ) {
    return 'test'
  }
  if (files.some((file) => /package(-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$/i.test(file))) {
    return 'chore'
  }
  if (files.some((file) => /\.(css|scss|tsx)$|features\/|components\//i.test(file))) {
    return 'feat'
  }
  return 'chore'
}

function inferSubject(type: string, files: string[]): string {
  if (type === 'docs') return 'update project documentation'
  if (type === 'test') return 'update test coverage'
  if (files.some((file) => /tools?\//i.test(file))) return 'improve assistant tooling'
  if (files.some((file) => /settings/i.test(file))) return 'update settings experience'
  if (files.some((file) => /chat/i.test(file))) return 'improve chat experience'
  if (files.length === 1) return `update ${files[0].split('/').pop() ?? 'project file'}`
  return 'update project files'
}

function runGit(command: string, cwd: string, signal?: AbortSignal): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    exec(
      `git ${command}`,
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

function gitError(
  command: string,
  result: GitCommandResult
): { modelResult: string; detail: string } {
  return {
    modelResult: `git ${command} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim() || 'unknown error'}`,
    detail: `exit ${result.code}`
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text
}
