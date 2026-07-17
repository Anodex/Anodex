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

async function isGitWorkspace(folderPath: string): Promise<boolean> {
  const result = await runGitCommand(['rev-parse', '--is-inside-work-tree'], folderPath)
  return result.ok && result.stdout.trim() === 'true'
}

function parseShortstat(output: string): { insertions: number; deletions: number } {
  const insertions = Number(output.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0)
  const deletions = Number(output.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0)
  return { insertions, deletions }
}

function addStats(
  left: { insertions: number; deletions: number },
  right: { insertions: number; deletions: number }
): { insertions: number; deletions: number } {
  return {
    insertions: left.insertions + right.insertions,
    deletions: left.deletions + right.deletions
  }
}

function parsePorcelain(output: string): {
  filesChanged: number
  staged: number
  unstaged: number
  untracked: number
} {
  let staged = 0
  let unstaged = 0
  let untracked = 0
  const lines = output.split('\n').filter((line) => line.trim().length > 0)

  for (const line of lines) {
    const indexStatus = line[0] ?? ' '
    const worktreeStatus = line[1] ?? ' '
    if (indexStatus === '?' && worktreeStatus === '?') {
      untracked += 1
      continue
    }
    if (indexStatus !== ' ') staged += 1
    if (worktreeStatus !== ' ') unstaged += 1
  }

  return { filesChanged: lines.length, staged, unstaged, untracked }
}

function parseAheadBehind(output: string | null): { ahead: number; behind: number } {
  if (!output) return { ahead: 0, behind: 0 }
  const [behindRaw, aheadRaw] = output.trim().split(/\s+/)
  return {
    ahead: Number(aheadRaw ?? 0) || 0,
    behind: Number(behindRaw ?? 0) || 0
  }
}

async function getCurrentBranch(folderPath: string): Promise<string | null> {
  const current = await runGit(['branch', '--show-current'], folderPath)
  if (current?.trim()) return current.trim()
  const symbolic = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], folderPath)
  return symbolic?.trim() || null
}

async function validateBranchName(folderPath: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Enter a branch name.')
  const result = await runGitCommand(['check-ref-format', '--branch', trimmed], folderPath)
  if (!result.ok) throw new Error('Enter a valid git branch name.')
}

export function hasGitRepo(folderPath: string): boolean {
  return existsSync(path.join(folderPath, '.git'))
}

export async function getGitWorkspaceStatus(folderPath: string): Promise<GitWorkspaceStatus> {
  if (!(await isGitWorkspace(folderPath))) {
    return {
      hasRepo: false,
      branch: null,
      headSha: null,
      remote: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      filesChanged: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      insertions: 0,
      deletions: 0,
      canPush: false
    }
  }

  const [branch, headSha, remotesOutput, upstreamOutput, stagedStat, unstagedStat, porcelain] =
    await Promise.all([
      getCurrentBranch(folderPath),
      runGit(['rev-parse', '--short', 'HEAD'], folderPath),
      runGit(['remote'], folderPath),
      runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], folderPath),
      runGit(['diff', '--shortstat', '--cached'], folderPath),
      runGit(['diff', '--shortstat'], folderPath),
      runGit(['status', '--porcelain'], folderPath)
    ])

  const remote =
    remotesOutput
      ?.split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? null
  const upstream = upstreamOutput?.trim() || null
  const aheadBehind = upstream
    ? parseAheadBehind(
        await runGit(['rev-list', '--left-right', '--count', `${upstream}...HEAD`], folderPath)
      )
    : { ahead: 0, behind: 0 }
  const stats = addStats(parseShortstat(stagedStat ?? ''), parseShortstat(unstagedStat ?? ''))
  const changeCounts = parsePorcelain(porcelain ?? '')

  return {
    hasRepo: true,
    branch,
    headSha: headSha?.trim() || null,
    remote,
    upstream,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    ...changeCounts,
    ...stats,
    canPush: Boolean(branch && remote && headSha?.trim())
  }
}

async function assertGitWorkspace(folderPath: string): Promise<void> {
  if (!(await isGitWorkspace(folderPath))) {
    throw new Error('This project is not a git repository yet.')
  }
}

async function assertBranchExists(folderPath: string, name: string): Promise<void> {
  const branches = await listBranches(folderPath)
  if (!branches.includes(name)) throw new Error('Choose an existing branch.')
}

export async function initGitRepo(folderPath: string): Promise<GitWorkspaceStatus> {
  const result = await runGitCommand(['init'], folderPath)
  if (!result.ok) throw new Error(result.stderr.trim() || 'Could not initialize the repository.')
  return getGitWorkspaceStatus(folderPath)
}

export async function createBranch(folderPath: string, name: string): Promise<GitWorkspaceStatus> {
  await assertGitWorkspace(folderPath)
  await validateBranchName(folderPath, name)
  const result = await runGitCommand(['checkout', '-b', name.trim()], folderPath)
  if (!result.ok) throw new Error(result.stderr.trim() || 'Could not create the branch.')
  return getGitWorkspaceStatus(folderPath)
}

export async function listBranches(folderPath: string): Promise<string[]> {
  await assertGitWorkspace(folderPath)
  const output = await runGit(['branch', '--format=%(refname:short)'], folderPath)
  if (!output) return []
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export async function switchBranch(folderPath: string, name: string): Promise<GitWorkspaceStatus> {
  await assertGitWorkspace(folderPath)
  await assertBranchExists(folderPath, name)
  const result = await runGitCommand(['checkout', name], folderPath)
  if (!result.ok) throw new Error(result.stderr.trim() || 'Could not switch branches.')
  return getGitWorkspaceStatus(folderPath)
}

export async function commitAll(folderPath: string, message: string): Promise<GitWorkspaceStatus> {
  await assertGitWorkspace(folderPath)
  const trimmedMessage = message.trim()
  if (!trimmedMessage) throw new Error('Enter a commit message.')

  const staged = await runGitCommand(['add', '-A'], folderPath)
  if (!staged.ok) throw new Error(staged.stderr.trim() || 'Could not stage changes.')

  const commit = await runGitCommand(['commit', '-m', trimmedMessage], folderPath)
  if (!commit.ok) {
    throw new Error(commit.stderr.trim() || commit.stdout.trim() || 'Could not commit.')
  }
  return getGitWorkspaceStatus(folderPath)
}

export async function pushBranch(folderPath: string): Promise<void> {
  await assertGitWorkspace(folderPath)
  const status = await getGitWorkspaceStatus(folderPath)
  if (!status.branch) throw new Error('Check out a branch before pushing.')
  if (!status.headSha) throw new Error('Create a commit before pushing.')
  if (!status.remote) throw new Error('Add a remote before pushing.')

  const args = status.upstream ? ['push'] : ['push', '--set-upstream', status.remote, status.branch]
  const result = await runGitCommand(args, folderPath)
  if (!result.ok) throw new Error(result.stderr.trim() || 'Could not push.')
}
