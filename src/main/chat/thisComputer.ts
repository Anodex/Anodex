import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { basename, delimiter, join } from 'node:path'
import type { PromptComputer } from '@shared/prompts'

export interface ComputerFacts {
  platform: NodeJS.Platform
  /** `os.release()`: the kernel version, which is how Windows and macOS versions are told apart. */
  release: string
  /** `/etc/os-release`'s contents on Linux, when readable. */
  osRelease: string | null
  folders: PromptComputer['folders']
  env: NodeJS.ProcessEnv
  hostname: string
  user: string
  /** Whether a program is on the PATH, so a hint never names one that is missing. */
  installed: (name: string) => boolean
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
    name: facts.hostname || undefined,
    user: facts.user || undefined,
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

/**
 * Whether a chat message might be asking for something on this computer, so
 * the turn should carry the shell's example commands.
 *
 * The examples are the strongest thing in the prompt for a small model, and it
 * copies them. Measured on Windows with Llama 3.1 8B, every plain question in a
 * chat became a command: "Name one fruit." searched the home folder for
 * '*apple*', "How many legs does a spider have?" for '*spider*', and "And the
 * capital of Germany?" ran the install check, `Get-Command python, python3,
 * py`, word for word. The rules beside the examples said to answer a fact in
 * words; the example list outweighed them.
 *
 * Generous on purpose. A message that matches gets exactly what every message
 * got before, so a false match costs nothing; only a message with no sign of
 * the computer in it — a fact, a sum, some writing — goes without the list.
 * run_command and the rules for it stay either way.
 */
export function mayConcernThisComputer(messages: string[]): boolean {
  return messages.some((message) => COMPUTER_WORDS.test(message) || PATH_LIKE.test(message))
}

const COMPUTER_WORDS = new RegExp(
  '\\b(?:' +
    [
      'computer',
      'laptop',
      'pc',
      'machine',
      'desktop',
      'downloads?',
      'documents?',
      'folders?',
      'director(?:y|ies)',
      'files?',
      'paths?',
      'drives?',
      'disks?',
      'storage',
      'space',
      'usb',
      '(?:un)?install(?:ed|ing|s)?',
      'programs?',
      'apps?',
      'applications?',
      'software',
      'versions?',
      'updates?',
      'open',
      'launch',
      'start',
      'run(?:ning)?',
      'clipboard',
      'copy',
      'paste',
      'zip',
      'unzip',
      'compress',
      'extract',
      'rename',
      'move',
      'delete',
      'remove',
      'trash',
      'recycle',
      'tidy',
      'clean',
      'memory',
      'ram',
      'cpu',
      'gpu',
      'process(?:es)?',
      'battery',
      'wi-?fi',
      'network',
      'internet',
      'ip',
      'bluetooth',
      'printer',
      'screen(?:shot)?s?',
      'photos?',
      'pictures?',
      'images?',
      'videos?',
      'music',
      'pdfs?',
      'resize',
      'backups?',
      'shell',
      'terminal',
      'command',
      'powershell',
      'bash',
      'scripts?',
      'python3?',
      'node',
      'java',
      'git',
      'npm',
      'pip',
      'winget',
      'brew',
      'apt',
      // Everyday asks that name no file or program word, found once this list
      // began deciding which tools a turn sees rather than only its examples.
      'kill',
      'close',
      'quit',
      'uptime',
      '(?:un)?mute',
      'volume',
      'sound',
      'brightness',
      'shut ?down',
      'restart',
      'reboot'
    ].join('|') +
    ')\\b',
  'i'
)

/**
 * Whether a chat message may need something from the web — a page, a search,
 * anything current — so the turn should keep the web tools in full view.
 *
 * Generous for the same reason as `mayConcernThisComputer`: a match only keeps
 * things as they were, and a miss still reaches the web tools through the
 * gateway (`find_available_tool`), just one step later. Measured on Windows with
 * Llama 3.1 8B, the miss it exists to prevent: "Who wrote Romeo and Juliet?"
 * fetched a web page before answering a fact it already knew.
 */
export function mayNeedTheWeb(messages: string[]): boolean {
  return messages.some((message) => WEB_WORDS.test(message) || URL_LIKE.test(message))
}

const WEB_WORDS = new RegExp(
  '\\b(?:' +
    [
      'web',
      'websites?',
      'sites?',
      'pages?',
      'links?',
      'urls?',
      'online',
      'internet',
      'search',
      'google',
      'look(?:ing)? (?:it )?up',
      'lookup',
      'browse',
      'latest',
      'news',
      'today',
      'tonight',
      'yesterday',
      'tomorrow',
      'this (?:week|month|year)',
      'current(?:ly)?',
      'recent(?:ly)?',
      'right now',
      'nowadays',
      'prices?',
      'stocks?',
      'weather',
      'forecast',
      'scores?',
      'who won',
      'released?',
      'download',
      'sources?',
      'cite',
      'research',
      '20[2-9]\\d'
    ].join('|') +
    ')\\b',
  'i'
)

/** http(s)://, www., or a bare domain such as example.com. */
const URL_LIKE = /https?:\/\/|\bwww\.|\b[\w-]+\.(?:com|org|net|io|dev|ai|co|gov|edu)\b/i

/** C:\, ~/, /home/ or /Users/, or a file name with an extension such as report.docx. */
const PATH_LIKE = /[a-z]:\\|~[\\/]|\/(?:home|users)\/|\b[\w-]+\.[a-z][a-z0-9]{1,4}\b/i

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
      // A placeholder, not a realistic name: measured on Windows, an 8B told
      // "an acre is 43560 square feet" ran this line exactly as written,
      // searching the whole home folder for '*budget*'.
      "Find files by part of the name: Get-ChildItem $HOME -Recurse -Filter '*<part of the name>*'",
      'Folder sizes: Get-ChildItem $HOME\\Documents -Directory | ForEach-Object { [pscustomobject]@{ Folder = $_.Name; MB = [math]::Round((Get-ChildItem $_.FullName -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1) } } | Sort-Object MB',
      "Free space on the drive the person's files are on: Get-PSDrive ($HOME.Substring(0, 1))",
      'Check whether a program is installed, under every name it goes by, then its version: Get-Command python, python3, py -ErrorAction SilentlyContinue, then python --version',
      "Memory in use, and the programs using most: Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 Name, @{n='MB'; e={[math]::Round($_.WorkingSet64 / 1MB)}}",
      'Move or rename: Move-Item "$HOME\\Desktop\\<old>" "$HOME\\Desktop\\<new>"',
      'Zip a folder, leaving it where it is: Compress-Archive -Path "$HOME\\Pictures\\<folder>" -DestinationPath "$HOME\\Desktop\\<folder>.zip"',
      'Open a file, folder or web address: Start-Process "$HOME\\Downloads"',
      "Copy text to the clipboard: Set-Clipboard -Value 'some text'",
      `Move to the Recycle Bin, ${ONLY_TO_REMOVE}: Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile("$HOME\\Downloads\\<file>", 'OnlyErrorDialogs', 'SendToRecycleBin') (DeleteDirectory for a folder)`,
      ...photoResize(facts),
      `${ONLY_WHEN_ASKED}: winget install --id <Id> -e --accept-source-agreements --accept-package-agreements (find the id with winget search <name>)`
    ]
  }
  // macOS and Linux share the POSIX half. `~` stays outside quotes in every
  // example: measured, an example written as find '<folder>' taught an 8B to
  // write find '~/Downloads', where the quotes stop ~ from meaning home.
  const posix = [
    "Find files by part of the name: find ~ -iname '*<part of the name>*'",
    'Folder sizes: du -sh ~/Documents/* | sort -h',
    "Free space on the drive the person's files are on: df -h ~",
    'Check whether a program is installed, under every name it goes by, then its version: command -v python3 python, then python3 --version',
    // Placeholders, never realistic names, in anything that changes files:
    // measured, a "gio trash ~/Downloads/old.zip" example was copied as the
    // target of a real command.
    // A backslash before a space does not survive a model's tool-call JSON:
    // measured, `Big\ Project` arrived as `Big\nProject`. Quotes do.
    "Move or rename, with quotes around a name that has spaces: mv ~/Documents/'<old name>' ~/Documents/'<new name>'"
  ]
  if (facts.platform === 'darwin') {
    return [
      ...posix,
      'Memory in use, and the programs using most: vm_stat; ps aux -m | head -n 6',
      ...zipFolder(facts),
      'Open a file, folder or web address: open ~/Downloads',
      "Copy text to the clipboard: printf '%s' 'some text' | pbcopy",
      `Move to the Trash, ${ONLY_TO_REMOVE}: osascript -e 'tell application "Finder" to delete POSIX file "/Users/<you>/Downloads/<file>"'`,
      ...photoResize(facts),
      `${ONLY_WHEN_ASKED}: brew install <name> (brew install --cask <name> for an app), if Homebrew is installed`
    ]
  }
  if (facts.platform === 'linux') {
    return [
      ...posix,
      'Memory in use, and the programs using most: free -h; ps aux --sort=-%mem | head -n 6',
      ...zipFolder(facts),
      'Open a file, folder or web address: xdg-open ~/Downloads',
      linuxClipboard(facts),
      `Move to the Trash, ${ONLY_TO_REMOVE}: gio trash ~/Downloads/<file>`,
      ...photoResize(facts),
      `${ONLY_WHEN_ASKED}: ${linuxPackageInstall(facts.osRelease)}, which asks the person for their password in a window, or flatpak install --user -y flathub <app-id> if flatpak is installed`
    ]
  }
  return []
}

/**
 * Zipping, with whatever this computer has. Measured: with no zip line, an 8B
 * invented a `gio compress` from the gio examples beside it, and moved the
 * folder it was asked to zip to the Trash along the way.
 */
function zipFolder(facts: ComputerFacts): string[] {
  const line = 'Zip a folder, leaving it where it is: '
  if (facts.installed('zip'))
    return [`${line}cd ~/Pictures && zip -r ~/Desktop/<folder>.zip <folder>`]
  if (facts.installed('python3')) {
    return [`${line}cd ~/Pictures && python3 -m zipfile -c ~/Desktop/<folder>.zip <folder>`]
  }
  return []
}

/**
 * How to make a smaller copy of a photo, with whatever this computer has.
 * Measured: with no ImageMagick but ffmpeg and Python installed, an 8B tried
 * convert, gm and mogrify and gave up, never thinking of ffmpeg. Named only
 * when a tool exists, so the line never sends a model after a missing program.
 */
function photoResize(facts: ComputerFacts): string[] {
  const line = 'Make a smaller copy of a photo (half size): '
  if (facts.installed('magick')) return [`${line}magick in.jpg -resize 50% out.jpg`]
  if (facts.platform === 'darwin') return [`${line}sips --resampleWidth 800 in.jpg --out out.jpg`]
  if (facts.installed('ffmpeg')) return [`${line}ffmpeg -i in.jpg -vf scale=iw/2:-1 out.jpg`]
  if (facts.installed('convert') && facts.platform !== 'win32') {
    return [`${line}convert in.jpg -resize 50% out.jpg`]
  }
  return []
}

/**
 * The clipboard command this Linux session can actually use. Measured: told
 * to use wl-copy on a machine without it, an 8B tried wl-copy, then xclip,
 * then xsel, none installed, and reported each failure in turn.
 */
function linuxClipboard(facts: ComputerFacts): string {
  const wayland = Boolean(facts.env.WAYLAND_DISPLAY)
  const candidates = [
    ...(wayland ? [['wl-copy', 'wl-copy']] : []),
    ['xclip', 'xclip -selection clipboard'],
    ['xsel', 'xsel --clipboard --input']
  ]
  const usable = candidates.find(([program]) => facts.installed(program))
  return usable
    ? `Copy text to the clipboard: printf '%s' 'some text' | ${usable[1]}`
    : `Copy text to the clipboard: no clipboard program is installed (${wayland ? 'wl-copy' : 'xclip'} would do it), so say so rather than trying`
}

/**
 * Installing is a change to the computer, made only on request. Measured with
 * an 8B: asked "is Java installed?", it read a bare "Install a program" line as
 * the answer and tried to install Java over and over, each attempt opening a
 * password window, and installed flatpak to try another way. Checking comes
 * first in the list for the same reason.
 */
const ONLY_WHEN_ASKED = 'Install a program, only when the person asks you to install one'

/**
 * The Trash is for a request to remove something, and nothing else. Measured
 * with an 8B asked to send a file to the phone: it wrote `gio trash <the file>
 * && xdg-open …`, reading a bare "Move to the Trash" line as one step of
 * sending. The person declined it at the prompt; the line no longer reads as
 * a general-purpose step.
 */
const ONLY_TO_REMOVE = 'only when the person asks to remove something'

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
    env: process.env,
    hostname: os.hostname(),
    user: currentUser(),
    installed: onPath
  }
}

function currentUser(): string {
  try {
    return os.userInfo().username
  } catch {
    return ''
  }
}

const pathLookups = new Map<string, boolean>()

/** Whether `name` is an executable on the PATH. Cached: the PATH does not change under a running app. */
function onPath(name: string): boolean {
  const cached = pathLookups.get(name)
  if (cached !== undefined) return cached
  const extensions =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  const found = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => extensions.some((ext) => existsSync(join(dir, name + ext))))
  pathLookups.set(name, found)
  return found
}
