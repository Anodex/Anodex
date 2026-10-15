import { exec } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { isWindowsOnlyShellElsewhere, resolveCommandShell } from '../commandShell'
import { migrateWindowsShellOffWindows } from '../../settings/SettingsStore'
import { createDefaultSettings } from '@shared/settings.defaults'

/**
 * How long a real shell gets to start and echo one word.
 *
 * Generous on purpose. A cold Windows PowerShell spawn is the thing under test,
 * so it cannot be warmed up or moved out of the test. It takes about five
 * seconds on the `windows-latest` runner in a normal run, and ran past an
 * earlier ten-second limit once while the rest of the suite had every core
 * busy. Locally the same contention makes a spawn five times slower. This only
 * bounds a hang; how fast the shell starts is not what the test proves.
 */
const SHELL_TIMEOUT_MS = 30_000

interface ShellOutcome {
  stdout: string
  diagnosis: string
}

/** Run `command` under `shell` as `run_command` does, resolving with enough to explain a failure. */
function runInShell(command: string, shell: string | undefined): Promise<ShellOutcome> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    exec(
      command,
      { shell, timeout: SHELL_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        const elapsed = `${Date.now() - startedAt} ms`
        if (!error) {
          resolve({ stdout, diagnosis: `${shell ?? 'default shell'} exited 0 after ${elapsed}` })
          return
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
        const how = failure.killed
          ? `was killed (${failure.signal ?? 'no signal'}) at the ${SHELL_TIMEOUT_MS} ms timeout`
          : `failed with code ${String(failure.code)}`
        resolve({
          stdout,
          diagnosis: [
            `${shell ?? 'default shell'} ${how} after ${elapsed}`,
            `stdout: ${JSON.stringify(stdout)}`,
            `stderr: ${JSON.stringify(stderr)}`
          ].join('\n')
        })
      }
    )
  })
}

describe('resolveCommandShell', () => {
  it('keeps PowerShell as the Windows default', () => {
    expect(resolveCommandShell('', 'win32', {})).toBe('powershell')
    expect(resolveCommandShell('cmd.exe', 'win32', {})).toBe('cmd.exe')
  })

  // The bug: `powershell` was handed to Node on Linux and macOS, where it does
  // not exist, and every command failed with `spawn powershell ENOENT`.
  it('runs Linux and macOS in the login shell when the setting names a Windows shell', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(resolveCommandShell('powershell', platform, { SHELL: '/bin/zsh' })).toBe('/bin/zsh')
      expect(resolveCommandShell('CMD.EXE', platform, { SHELL: '/bin/bash' })).toBe('/bin/bash')
      expect(resolveCommandShell('', platform, { SHELL: '/bin/bash' })).toBe('/bin/bash')
    }
  })

  it("falls back to Node's own default when there is no login shell", () => {
    expect(resolveCommandShell('powershell', 'linux', {})).toBeUndefined()
  })

  it('respects a real choice', () => {
    expect(resolveCommandShell('pwsh', 'linux', { SHELL: '/bin/bash' })).toBe('pwsh')
    expect(resolveCommandShell('/usr/bin/fish', 'darwin', { SHELL: '/bin/zsh' })).toBe(
      '/usr/bin/fish'
    )
  })

  it(
    'actually runs a command on this machine with the shipped default',
    async () => {
      const shell = resolveCommandShell(createDefaultSettings('').general.defaultShell)
      const { stdout, diagnosis } = await runInShell('echo anodex-shell-ok', shell)
      expect(stdout.trim(), diagnosis).toBe('anodex-shell-ok')
    },
    SHELL_TIMEOUT_MS + 10_000
  )

  it(
    'actually runs a command on this machine with a setting carried over from Windows',
    async () => {
      const shell = resolveCommandShell('powershell')
      if (process.platform === 'win32') return
      const { stdout, diagnosis } = await runInShell('echo anodex-shell-ok', shell)
      expect(stdout.trim(), diagnosis).toBe('anodex-shell-ok')
    },
    SHELL_TIMEOUT_MS + 10_000
  )
})

describe('migrateWindowsShellOffWindows', () => {
  const withShell = (defaultShell: string): ReturnType<typeof createDefaultSettings> => {
    const settings = createDefaultSettings('')
    return { ...settings, general: { ...settings.general, defaultShell } }
  }

  it('clears a Windows-only shell stored on Linux or macOS', () => {
    expect(
      migrateWindowsShellOffWindows(withShell('powershell'), 'linux').general.defaultShell
    ).toBe('')
    expect(isWindowsOnlyShellElsewhere('cmd', 'darwin')).toBe(true)
  })

  it('leaves Windows, and real choices elsewhere, alone', () => {
    const windows = withShell('powershell')
    expect(migrateWindowsShellOffWindows(windows, 'win32')).toBe(windows)
    const zsh = withShell('zsh')
    expect(migrateWindowsShellOffWindows(zsh, 'linux')).toBe(zsh)
  })
})
