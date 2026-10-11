import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

/** Folders a request may name by their everyday name instead of a path. */
export type KnownFolders = Partial<
  Record<'desktop' | 'documents' | 'downloads' | 'home' | 'temp', string>
>

type PathApi = typeof path.posix

function pathFor(platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? path.win32 : path.posix
}

/** Windows and macOS file systems ignore case; Linux does not. */
function caseless(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

function normalize(value: string, platform: NodeJS.Platform): string {
  const p = pathFor(platform)
  const resolved = p.resolve(value)
  const root = p.parse(resolved).root
  const trimmed = resolved !== root && resolved.endsWith(p.sep) ? resolved.slice(0, -1) : resolved
  return caseless(platform) ? trimmed.toLowerCase() : trimmed
}

/**
 * Turn what the model asked for into one absolute folder, or say why not.
 *
 * Accepts an absolute path, `~/…`, or a path that starts with an everyday
 * folder name (`Desktop/minecraft`), resolved through the OS's own idea of
 * where that folder is, since a Desktop is not always `~/Desktop` (OneDrive
 * moves it on Windows; other languages rename it on Linux).
 *
 * Refuses what is too broad to hand over: a drive or filesystem root, the home
 * folder itself, and the operating system's own folders. Asking for the folder
 * the work belongs in is the point; asking for the whole disk is not.
 */
export function resolveRequestedFolder(
  requested: string,
  known: KnownFolders,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): { ok: true; path: string } | { ok: false; reason: string } {
  const p = pathFor(platform)
  const raw = requested.trim().replace(/^["']|["']$/g, '')
  if (!raw) return { ok: false, reason: 'No folder was named.' }

  const home = known.home ?? homedir()
  let target: string
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    target = p.join(home, raw.slice(1))
  } else if (p.isAbsolute(raw)) {
    target = raw
  } else {
    const [first, ...rest] = raw.split(/[\\/]/)
    const base = known[first.toLowerCase() as keyof KnownFolders]
    if (!base) {
      return {
        ok: false,
        reason: `"${raw}" is not a full path. Name it from the home folder (~/…), from Desktop, Documents or Downloads, or as an absolute path.`
      }
    }
    target = p.join(base, ...rest)
  }
  target = p.resolve(target)

  const refused = tooBroadReason(target, home, known.temp ?? tmpdir(), platform, env)
  return refused ? { ok: false, reason: refused } : { ok: true, path: target }
}

function systemFolders(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const drive = env.SystemDrive ?? 'C:'
    return [
      env.SystemRoot ?? `${drive}\\Windows`,
      env.ProgramFiles ?? `${drive}\\Program Files`,
      env['ProgramFiles(x86)'] ?? `${drive}\\Program Files (x86)`,
      env.ProgramData ?? `${drive}\\ProgramData`
    ]
  }
  if (platform === 'darwin') {
    return [
      '/System',
      '/Library',
      '/Applications',
      '/bin',
      '/sbin',
      '/usr',
      '/etc',
      '/private',
      '/var',
      '/opt'
    ]
  }
  return [
    '/bin',
    '/sbin',
    '/usr',
    '/etc',
    '/boot',
    '/dev',
    '/proc',
    '/sys',
    '/lib',
    '/lib64',
    '/var',
    '/opt',
    '/root',
    '/run',
    '/snap'
  ]
}

function tooBroadReason(
  target: string,
  home: string,
  temp: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string | null {
  const p = pathFor(platform)
  const norm = normalize(target, platform)
  if (norm === normalize(p.parse(target).root, platform)) {
    return 'That is a whole drive. Ask for the folder the work belongs in instead.'
  }
  if (norm === normalize(home, platform)) {
    return 'That is your whole home folder. Ask for the folder the work belongs in instead.'
  }
  // The user's own temp folder is theirs to work in, even where it sits under
  // a system folder: on macOS it is inside /var/folders.
  const tempRoot = normalize(temp, platform)
  if (norm !== tempRoot && norm.startsWith(tempRoot + p.sep)) return null
  for (const folder of systemFolders(platform, env)) {
    const root = normalize(folder, platform)
    if (norm === root || norm.startsWith(root + p.sep)) {
      return `That is part of the operating system (${folder}). Anodex does not work in system folders.`
    }
  }
  return null
}

/** Whether two folder paths name the same folder, by this platform's case rules. */
export function sameFolder(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return normalize(a, platform) === normalize(b, platform)
}
