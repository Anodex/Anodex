import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { isWindowsOnlyShellElsewhere, resolveCommandShell } from '../commandShell'
import { migrateWindowsShellOffWindows } from '../../settings/SettingsStore'
import { createDefaultSettings } from '@shared/settings.defaults'

const run = promisify(exec)

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

  it('actually runs a command on this machine with the shipped default', async () => {
    const shell = resolveCommandShell(createDefaultSettings('').general.defaultShell)
    const { stdout } = await run('echo anodex-shell-ok', { shell, timeout: 10_000 })
    expect(stdout.trim()).toBe('anodex-shell-ok')
  })

  it('actually runs a command on this machine with a setting carried over from Windows', async () => {
    const shell = resolveCommandShell('powershell')
    if (process.platform === 'win32') return
    const { stdout } = await run('echo anodex-shell-ok', { shell, timeout: 10_000 })
    expect(stdout.trim()).toBe('anodex-shell-ok')
  })
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
