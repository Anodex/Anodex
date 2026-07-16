import { execFile } from 'node:child_process'

const GIT_TIMEOUT_MS = 10_000

/** Converts GitHub HTTPS/SSH remotes and `owner/repo` input into one canonical form. */
export function normalizeGithubRepository(value: string): string | null {
  const trimmed = value
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/$/, '')
  if (!trimmed) return null

  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return trimmed

  const scpMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+)$/i)
  if (scpMatch) return normalizeOwnerAndRepo(scpMatch[1], scpMatch[2])

  try {
    const url = new URL(trimmed)
    if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) return null
    const [owner, repo, ...rest] = url.pathname.split('/').filter(Boolean)
    if (!owner || !repo || rest.length > 0) return null
    return normalizeOwnerAndRepo(owner, repo)
  } catch {
    return null
  }
}

export async function detectGithubRepository(folderPath: string): Promise<string | null> {
  const remote = await new Promise<string | null>((resolve) => {
    execFile(
      'git',
      ['remote', 'get-url', 'origin'],
      { cwd: folderPath, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout.trim() || null)
    )
  })
  return remote ? normalizeGithubRepository(remote) : null
}

function normalizeOwnerAndRepo(owner: string, repository: string): string | null {
  const repo = repository.replace(/\.git$/i, '').replace(/\/$/, '')
  return /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(repo) ? `${owner}/${repo}` : null
}
