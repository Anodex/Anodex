import { homedir } from 'node:os'
import path from 'node:path'

/**
 * The ways a model writes "the home folder" at the start of a path.
 *
 * A model writes these from shell habit, and Anodex's own Windows examples in
 * the "This computer" section teach `$HOME`. A tool that takes a path is not a
 * shell, so nothing expanded them: measured with Gemma 4 E4B, `check_computer`
 * was asked for the free space on `$HOME` and measured a folder literally named
 * `$HOME` inside the app's own directory, failed, and had to try again.
 *
 * POSIX (`~`, `$HOME`, `${HOME}`), PowerShell (`$HOME`, `$env:USERPROFILE`,
 * `$env:HOME`) and cmd (`%USERPROFILE%`) forms, case-insensitive because
 * Windows environment names are, and only as a whole first segment, so
 * `~backup` or `$HOMEWORK` are left alone.
 */
const HOME_PREFIX =
  /^(?:~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%)(?=$|[\\/])/i

/**
 * `raw` with a leading home shorthand replaced by `home`, or null when it has
 * none. Joined with the platform's own rules, so `~/Documents` becomes
 * `C:\Users\sam\Documents` on Windows and `/home/sam/Documents` elsewhere.
 */
export function expandHomeShorthand(
  raw: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): string | null {
  const match = HOME_PREFIX.exec(raw)
  if (!match) return null
  const rest = raw.slice(match[0].length).replace(/^[\\/]+/, '')
  const p = platform === 'win32' ? path.win32 : path.posix
  return rest ? p.join(home, rest) : home
}
