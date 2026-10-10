/** Shells that exist only on Windows. Named anywhere else, they cannot start. */
const WINDOWS_ONLY_SHELL = /^(powershell|cmd)(\.exe)?$/i

/**
 * The shell `run_command` and the project checks should run under.
 *
 * The setting used to default to `powershell` on every platform and was handed
 * to Node as-is, so on Linux and macOS, where PowerShell is not installed (and
 * is called `pwsh` when it is), every command failed with `spawn powershell
 * ENOENT` before it started.
 *
 * An empty setting means the platform's own: PowerShell on Windows, the user's
 * login shell elsewhere. A Windows-only shell named on another platform is read
 * the same way, so a setting carried over from a Windows machine still works.
 * Any other choice (`pwsh`, `zsh`, a full path) is respected. `undefined` lets
 * Node pick its default (`/bin/sh`) when `$SHELL` is unset.
 */
export function resolveCommandShell(
  setting: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const chosen = setting.trim()
  if (platform === 'win32') return chosen || 'powershell'
  if (!chosen || WINDOWS_ONLY_SHELL.test(chosen)) return env.SHELL?.trim() || undefined
  return chosen
}

/** Whether a stored shell setting can never run on this platform and should read as the default. */
export function isWindowsOnlyShellElsewhere(
  setting: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform !== 'win32' && WINDOWS_ONLY_SHELL.test(setting.trim())
}
