import { lstat, readdir } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'

/** One thing that can safely go, and how big it is. */
export interface CleanupCandidate {
  /** Stable id the trash tool takes: `npm-cache`, `old-downloads`. */
  id: string
  label: string
  /** Why it is safe to remove, said plainly. */
  why: string
  /** The folder it lives in, for display. */
  where: string
  /** What would actually be moved to the Trash. */
  paths: string[]
  sizeBytes: number
  /** True when sizing stopped early on a very large folder, so `sizeBytes` is a lower bound. */
  atLeast: boolean
}

export interface CleanupEnv {
  platform: NodeJS.Platform
  home: string
  tmp: string
  downloads: string | null
  env: NodeJS.ProcessEnv
  now: number
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Stops sizing a folder past this many entries, so a scan never runs for minutes. */
const MAX_ENTRIES_SIZED = 200_000

/** Package caches that tools rebuild on their own the next time they need them. */
function cacheFolders(env: CleanupEnv): Array<{ id: string; label: string; path: string }> {
  const { platform, home } = env
  const local = env.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const npm =
    env.env.npm_config_cache ??
    (platform === 'win32' ? join(local, 'npm-cache') : join(home, '.npm'))
  const caches =
    platform === 'darwin'
      ? join(home, 'Library', 'Caches')
      : platform === 'win32'
        ? local
        : (env.env.XDG_CACHE_HOME ?? join(home, '.cache'))
  return [
    { id: 'npm-cache', label: 'npm cache', path: join(npm, '_cacache') },
    {
      id: 'yarn-cache',
      label: 'Yarn cache',
      path:
        platform === 'win32'
          ? join(local, 'Yarn', 'Cache')
          : join(caches, platform === 'darwin' ? 'Yarn' : 'yarn')
    },
    {
      id: 'pip-cache',
      label: 'pip cache',
      path: platform === 'win32' ? join(local, 'pip', 'Cache') : join(caches, 'pip')
    }
  ]
}

/**
 * Everything worth clearing on this machine, biggest first. Only places whose
 * contents are disposable by design: package caches that rebuild themselves,
 * temp files nothing has touched for a week, and downloads untouched for a
 * year. Nothing in a project, nothing a person made and still uses.
 */
export async function findCleanupCandidates(env: CleanupEnv): Promise<CleanupCandidate[]> {
  const found: CleanupCandidate[] = []

  for (const cache of cacheFolders(env)) {
    const size = await sizeOf(cache.path)
    if (size && size.bytes > 0) {
      found.push({
        id: cache.id,
        label: cache.label,
        why: 'Downloaded packages kept for reuse; rebuilt automatically when needed.',
        where: cache.path,
        paths: [cache.path],
        sizeBytes: size.bytes,
        atLeast: size.truncated
      })
    }
  }

  const oldTemp = await oldEntries(env.tmp, env.now - 7 * DAY_MS)
  if (oldTemp.paths.length > 0) {
    found.push({
      id: 'old-temp-files',
      label: 'Old temporary files',
      why: 'Temporary files nothing has changed in over a week.',
      where: env.tmp,
      ...oldTemp
    })
  }

  if (env.downloads) {
    const oldDownloads = await oldEntries(env.downloads, env.now - 365 * DAY_MS, true)
    if (oldDownloads.paths.length > 0) {
      found.push({
        id: 'old-downloads',
        label: 'Downloads older than a year',
        why: `${oldDownloads.paths.length} files in Downloads not changed in over a year.`,
        where: env.downloads,
        ...oldDownloads
      })
    }
  }

  return found.sort((a, b) => b.sizeBytes - a.sizeBytes)
}

/** The top-level entries of `dir` last changed before `before`. Files only, when asked. */
async function oldEntries(
  dir: string,
  before: number,
  filesOnly = false
): Promise<{ paths: string[]; sizeBytes: number; atLeast: boolean }> {
  const paths: string[] = []
  let sizeBytes = 0
  let atLeast = false
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return { paths, sizeBytes, atLeast }
  }
  for (const name of names) {
    const path = join(dir, name)
    try {
      const stats = await lstat(path)
      if (stats.isSymbolicLink() || stats.mtimeMs >= before) continue
      if (filesOnly && !stats.isFile()) continue
      const size = stats.isDirectory()
        ? await sizeOf(path)
        : { bytes: stats.size, truncated: false }
      if (!size) continue
      paths.push(path)
      sizeBytes += size.bytes
      atLeast ||= size.truncated
    } catch {
      // gone, or not ours to read
    }
  }
  return { paths, sizeBytes, atLeast }
}

/** Total size of a folder, never following links. Null when it does not exist. */
export async function sizeOf(path: string): Promise<{ bytes: number; truncated: boolean } | null> {
  try {
    const root = await lstat(path)
    if (!root.isDirectory()) return { bytes: root.size, truncated: false }
  } catch {
    return null
  }
  let bytes = 0
  let entries = 0
  const stack = [path]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (++entries > MAX_ENTRIES_SIZED) return { bytes, truncated: true }
      const child = join(dir, name)
      try {
        const stats = await lstat(child)
        if (stats.isSymbolicLink()) continue
        if (stats.isDirectory()) stack.push(child)
        else bytes += stats.size
      } catch {
        // skip what cannot be read
      }
    }
  }
  return { bytes, truncated: false }
}

/** The machine's real folders, for the tools. Tests pass their own. */
export function liveCleanupEnv(downloads: string | null): CleanupEnv {
  return {
    platform: process.platform,
    home: os.homedir(),
    tmp: os.tmpdir(),
    downloads,
    env: process.env,
    now: Date.now()
  }
}
