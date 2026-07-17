import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { GitWorkspaceStatus } from '@shared/git.types'

const GIT_TIMEOUT_MS = 10_000

interface GitCommandResult {
  ok: boolean
  stdout: string
  stderr: string
}

function runGitCommand(args: string[], cwd: string): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr })
    )
  })
}

async function runGit(args: string[], cwd: string): Promise<string | null> {
  const result = await runGitCommand(args, cwd)
  return result.ok ? result.stdout : null
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

export async function createBranch(folderPath: string, name: string): Promise<GitWorkspaceStatus> {
  const result = await runGitCommand(['checkout', '-b', name], folderPath)
  if (!result.ok) throw new Error(result.stderr.trim() || 'Could not create the branch.')
  return getGitWorkspaceStatus(folderPath)
}

export async function listBranches(folderPath: string): Promise<string[]> {
  const output = await runGit(['branch', '--format=%(refname:short)'], folderPath)
  if (!output) return []
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export async function switchBranch(folderPath: string, name: string): Promise<GitWorkspaceStatus> {
  const result = await runGitCommand(['checkout', name], folderPath)
  if (!result.ok) throw new Error(result.stderr.trim() || 'Could not switch branches.')
  return getGitWorkspaceStatus(folderPath)
}

export async function commitAll(folderPath: string, message: string): Promise<GitWorkspaceStatus> {
  const staged = await runGitCommand(['add', '-A'], folderPath)
  if (!staged.ok) throw new Error(staged.stderr.trim() || 'Could not stage changes.')

  const commit = await runGitCommand(['commit', '-m', message], folderPath)
  if (!commit.ok) {
    throw new Error(commit.stderr.trim() || commit.stdout.trim() || 'Could not commit.')
  }
  return getGitWorkspaceStatus(folderPath)
}

export async function pushBranch(folderPath: string): Promise<void> {
  const hasUpstream = await runGitCommand(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    folderPath
  )
  const args = hasUpstream.ok ? ['push'] : ['push', '--set-upstream', 'origin', 'HEAD']
  const result = await runGitCommand(args, folderPath)
  if (!result.ok) throw new Error(result.stderr.trim() || 'Could not push.')
}
