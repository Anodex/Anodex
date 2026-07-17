import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { GitWorkspaceStatus } from '@shared/git.types'

const GIT_TIMEOUT_MS = 10_000

function runGit(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
      resolve(error ? null : stdout)
    )
  })
}

function parseShortstat(output: string): { insertions: number; deletions: number } {
  const insertions = Number(output.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0)
  const deletions = Number(output.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0)
  return { insertions, deletions }
}

export function hasGitRepo(folderPath: string): boolean {
  return existsSync(path.join(folderPath, '.git'))
}

export async function getGitWorkspaceStatus(folderPath: string): Promise<GitWorkspaceStatus> {
  if (!hasGitRepo(folderPath)) {
    return { hasRepo: false, branch: null, filesChanged: 0, insertions: 0, deletions: 0 }
  }

  const [branchOutput, shortstat, porcelain] = await Promise.all([
    runGit(['branch', '--show-current'], folderPath),
    runGit(['diff', '--shortstat', 'HEAD'], folderPath),
    runGit(['status', '--porcelain'], folderPath)
  ])

  const branch = branchOutput?.trim() || null
  const { insertions, deletions } = parseShortstat(shortstat ?? '')
  const filesChanged = porcelain
    ? porcelain.split('\n').filter((line) => line.trim().length > 0).length
    : 0

  return { hasRepo: true, branch, filesChanged, insertions, deletions }
}

export async function initGitRepo(folderPath: string): Promise<GitWorkspaceStatus> {
  await runGit(['init'], folderPath)
  return getGitWorkspaceStatus(folderPath)
}
