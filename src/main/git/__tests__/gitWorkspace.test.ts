import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commitAll, createBranch, getGitWorkspaceStatus, initGitRepo } from '../gitWorkspace'

function git(args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd }, (error) => resolve(!error))
  })
}

describe('gitWorkspace', () => {
  let workspace: string
  let gitAvailable = false

  beforeEach(async () => {
    gitAvailable = await git(['--version'], tmpdir())
    workspace = await mkdtemp(join(tmpdir(), 'anodex-git-workspace-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('returns an inactive status outside a repository', async () => {
    const status = await getGitWorkspaceStatus(workspace)

    expect(status).toMatchObject({
      hasRepo: false,
      branch: null,
      filesChanged: 0,
      canPush: false
    })
  })

  it('reports unborn repositories and untracked files', async () => {
    if (!gitAvailable) return
    await initGitRepo(workspace)

    const emptyStatus = await getGitWorkspaceStatus(workspace)
    expect(emptyStatus.hasRepo).toBe(true)
    expect(emptyStatus.headSha).toBeNull()
    expect(emptyStatus.branch).toBeTruthy()

    await writeFile(join(workspace, 'README.md'), '# Demo\n', 'utf-8')
    const dirtyStatus = await getGitWorkspaceStatus(workspace)

    expect(dirtyStatus.filesChanged).toBe(1)
    expect(dirtyStatus.untracked).toBe(1)
    expect(dirtyStatus.staged).toBe(0)
  })

  it('commits all tracked and untracked files', async () => {
    if (!gitAvailable) return
    await initGitRepo(workspace)
    await git(['config', 'user.email', 'test@anodex.local'], workspace)
    await git(['config', 'user.name', 'Anodex Test'], workspace)
    await writeFile(join(workspace, 'README.md'), '# Demo\n', 'utf-8')

    const status = await commitAll(workspace, 'docs: add readme')

    expect(status.headSha).toBeTruthy()
    expect(status.filesChanged).toBe(0)
  })

  it('rejects invalid branch names before checkout', async () => {
    if (!gitAvailable) return
    await initGitRepo(workspace)

    await expect(createBranch(workspace, 'bad branch name')).rejects.toThrow(
      'Enter a valid git branch name.'
    )
  })

  it('surfaces remote presence separately from upstream tracking', async () => {
    if (!gitAvailable) return
    await initGitRepo(workspace)
    await git(['remote', 'add', 'origin', 'https://github.com/example/demo.git'], workspace)

    const unbornStatus = await getGitWorkspaceStatus(workspace)

    expect(unbornStatus.remote).toBe('origin')
    expect(unbornStatus.upstream).toBeNull()
    expect(unbornStatus.canPush).toBe(false)

    await git(['config', 'user.email', 'test@anodex.local'], workspace)
    await git(['config', 'user.name', 'Anodex Test'], workspace)
    await writeFile(join(workspace, 'README.md'), '# Demo\n', 'utf-8')
    const committedStatus = await commitAll(workspace, 'docs: add readme')

    expect(committedStatus.canPush).toBe(true)
  })
})
