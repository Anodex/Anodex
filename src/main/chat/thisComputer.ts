import { readFileSync } from 'node:fs'
import os from 'node:os'
import { basename, join } from 'node:path'
import type { PromptComputer } from '@shared/prompts'

export interface ComputerFacts {
  platform: NodeJS.Platform
  /** `os.release()`: the kernel version, which is how Windows and macOS versions are told apart. */
  release: string
  /** `/etc/os-release`'s contents on Linux, when readable. */
  osRelease: string | null
  folders: PromptComputer['folders']
  env: NodeJS.ProcessEnv
}

/**
 * The prompt's "This computer" section, from facts about the machine.
 *
 * `shell` is the resolved run_command shell (`resolveCommandShell`), and
 * `shellStartsIn` where commands begin; both are omitted when the turn has no
 * shell, and the section then names only the system and its folders.
 */
export function describeComputer(
  facts: ComputerFacts,
  shell: { command: string | undefined; startsIn: string } | null
): PromptComputer {
  const platform =
    facts.platform === 'win32' || facts.platform === 'darwin' || facts.platform === 'linux'
      ? facts.platform
      : 'other'
  const computer: PromptComputer = {
    os: osName(facts),
    platform,
    folders: facts.folders
  }
  if (shell) {
    const name = shellName(shell.command, facts.platform)
    computer.shell = {
      name,
      startsIn: shell.startsIn,
      howTo: everydayCommands(facts, name)
    }
  }
  return computer
}

function osName(facts: ComputerFacts): string {
  if (facts.platform === 'win32') {
    // Windows 11 still reports itself as 10.0; the build number is what differs.
    const build = Number(facts.release.split('.')[2])
    return Number.isFinite(build) && build >= 22000 ? 'Windows 11' : 'Windows 10'
  }
  if (facts.platform === 'darwin') {
    const darwin = Number(facts.release.split('.')[0])
    // Darwin 20–24 are macOS 11–15; Darwin 25 is macOS 26, when Apple's
    // numbering jumped to the year.
    if (darwin >= 25) return `macOS ${darwin + 1}`
    if (darwin >= 20) return `macOS ${darwin - 9}`
    return 'macOS'
  }
  if (facts.platform === 'linux') {
    const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(facts.osRelease ?? '')?.[1]
    return pretty ? `Linux (${pretty})` : 'Linux'
  }
  return facts.platform
}

function shellName(command: string | undefined, platform: NodeJS.Platform): string {
  if (!command) return platform === 'win32' ? 'cmd' : 'sh'
  const name = basename(command.replace(/\\/g, '/')).replace(/\.exe$/i, '')
  if (/^powershell$/i.test(name)) return 'Windows PowerShell'
  if (/^pwsh$/i.test(name)) return 'PowerShell'
  return name
}

/** Whether the shell takes PowerShell syntax. */
function isPowerShell(name: string): boolean {
  return /PowerShell/.test(name)
}

/**
 * The everyday commands a model most often gets wrong for the system it is on.
 *
 * Short on purpose: these sit in every turn's prompt, and a local model on an
 * 8K window pays for each line. Only what differs by system and is asked for
 * in ordinary chat — opening, the clipboard, the Trash, installing.
 */
function everydayCommands(facts: ComputerFacts, shell: string): string[] {
  if (facts.platform === 'win32') {
    if (!isPowerShell(shell)) return []
    return [
      "Find files: Get-ChildItem '<folder>' -Recurse -Filter '*.pdf'",
      'Check whether a program is installed: Get-Command <name> -ErrorAction SilentlyContinue, then <name> --version',
      "Open a file, folder or web address: Start-Process '<path or url>'",
      "Copy text to the clipboard: Set-Clipboard -Value '<text>'",
      "Move to the Recycle Bin: Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('<file>', 'OnlyErrorDialogs', 'SendToRecycleBin') (DeleteDirectory for a folder)",
      `${ONLY_WHEN_ASKED}: winget install --id <Id> -e --accept-source-agreements --accept-package-agreements (find the id with winget search <name>)`
    ]
  }
  if (facts.platform === 'darwin') {
    return [
      "Find files: find '<folder>' -iname '*.pdf'",
      'Check whether a program is installed: command -v <name>, then <name> --version',
      "Open a file, folder or web address: open '<path or url>'",
      "Copy text to the clipboard: printf '%s' '<text>' | pbcopy",
      `Move to the Trash: osascript -e 'tell application "Finder" to delete POSIX file "<absolute path>"'`,
      `${ONLY_WHEN_ASKED}: brew install <name> (brew install --cask <name> for an app), if Homebrew is installed`
    ]
  }
  if (facts.platform === 'linux') {
    const wayland = Boolean(facts.env.WAYLAND_DISPLAY)
    return [
      "Find files: find '<folder>' -iname '*.pdf'",
      'Check whether a program is installed: command -v <name>, then <name> --version',
      "Open a file, folder or web address: xdg-open '<path or url>'",
      `Copy text to the clipboard: printf '%s' '<text>' | ${wayland ? 'wl-copy' : 'xclip -selection clipboard'}`,
      "Move to the Trash: gio trash '<path>'",
      `${ONLY_WHEN_ASKED}: ${linuxPackageInstall(facts.osRelease)}, which asks the person for their password in a window, or flatpak install --user -y flathub <app-id> if flatpak is installed`
    ]
  }
  return []
}

/**
 * Installing is a change to the computer, made only on request. Measured with
 * an 8B: asked "is Java installed?", it read a bare "Install a program" line as
 * the answer and tried to install Java over and over, each attempt opening a
 * password window, and installed flatpak to try another way. Checking comes
 * first in the list for the same reason.
 */
const ONLY_WHEN_ASKED = 'Install a program, only when the person asks you to install one'

function linuxPackageInstall(osRelease: string | null): string {
  // ID names the distribution and ID_LIKE what it derives from (Mint: ubuntu debian).
  const family = [...(osRelease ?? '').matchAll(/^ID(?:_LIKE)?="?([^"\n]+)"?/gm)]
    .map((match) => match[1])
    .join(' ')
  if (/\b(debian|ubuntu)\b/.test(family)) return 'pkexec apt-get install -y <package>'
  if (/\b(fedora|rhel|centos)\b/.test(family)) return 'pkexec dnf install -y <package>'
  if (/\barch\b/.test(family)) return 'pkexec pacman -S --noconfirm <package>'
  if (/\b(suse|opensuse)\b/.test(family)) return 'pkexec zypper --non-interactive install <package>'
  return "pkexec with the system's package manager"
}

let cachedOsRelease: string | null | undefined

function readOsRelease(): string | null {
  if (cachedOsRelease !== undefined) return cachedOsRelease
  try {
    cachedOsRelease = readFileSync('/etc/os-release', 'utf8')
  } catch {
    cachedOsRelease = null
  }
  return cachedOsRelease
}

/** This machine's facts. `appPath` is Electron's `app.getPath`, passed so tests need no Electron. */
export function liveComputerFacts(
  appPath: (name: 'desktop' | 'documents' | 'downloads') => string
): ComputerFacts {
  const home = os.homedir()
  const folder = (name: 'desktop' | 'documents' | 'downloads', fallback: string): string => {
    try {
      return appPath(name)
    } catch {
      return join(home, fallback)
    }
  }
  return {
    platform: process.platform,
    release: os.release(),
    osRelease: process.platform === 'linux' ? readOsRelease() : null,
    folders: {
      home,
      desktop: folder('desktop', 'Desktop'),
      documents: folder('documents', 'Documents'),
      downloads: folder('downloads', 'Downloads')
    },
    env: process.env
  }
}
