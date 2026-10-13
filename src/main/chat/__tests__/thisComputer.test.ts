import { describe, expect, it } from 'vitest'
import { composeSystemPrompt, NO_PROJECT_SHELL_NOTE, NO_WORKSPACE_NOTE } from '@shared/prompts'
import { describeComputer, type ComputerFacts } from '../thisComputer'

const folders = {
  home: '/home/sam',
  desktop: '/home/sam/Desktop',
  documents: '/home/sam/Documents',
  downloads: '/home/sam/Downloads'
}

function facts(overrides: Partial<ComputerFacts>): ComputerFacts {
  return {
    platform: 'linux',
    release: '6.8.0',
    osRelease: null,
    folders,
    env: {},
    installed: () => true,
    hostname: 'gort',
    user: 'sam',
    ...overrides
  }
}

const shell = (command: string | undefined) => ({ command, startsIn: folders.home })

describe('describeComputer', () => {
  it('tells Windows 11 from 10 by build, and gives PowerShell its own commands', () => {
    const eleven = describeComputer(
      facts({ platform: 'win32', release: '10.0.22631' }),
      shell('powershell')
    )
    expect(eleven.os).toBe('Windows 11')
    expect(eleven.shell?.name).toBe('Windows PowerShell')
    expect(eleven.shell?.howTo.join('\n')).toContain('Start-Process')
    expect(eleven.shell?.howTo.join('\n')).toContain('SendToRecycleBin')
    expect(eleven.shell?.howTo.join('\n')).toContain('winget install')
    expect(eleven.shell?.howTo.join('\n')).toContain('Get-Command python, python3, py')

    const ten = describeComputer(facts({ platform: 'win32', release: '10.0.19045' }), null)
    expect(ten.os).toBe('Windows 10')
    expect(ten.shell).toBeUndefined()
  })

  it('gives no PowerShell commands to someone who chose cmd', () => {
    const cmd = describeComputer(
      facts({ platform: 'win32', release: '10.0.22631' }),
      shell('cmd.exe')
    )
    expect(cmd.shell?.name).toBe('cmd')
    expect(cmd.shell?.howTo).toEqual([])
  })

  it('names macOS versions, including the jump to 26', () => {
    expect(describeComputer(facts({ platform: 'darwin', release: '24.1.0' }), null).os).toBe(
      'macOS 15'
    )
    expect(describeComputer(facts({ platform: 'darwin', release: '25.0.0' }), null).os).toBe(
      'macOS 26'
    )
    const mac = describeComputer(
      facts({ platform: 'darwin', release: '24.1.0' }),
      shell('/bin/zsh')
    )
    expect(mac.shell?.name).toBe('zsh')
    expect(mac.shell?.howTo.join('\n')).toContain('pbcopy')
  })

  it("names the Linux distribution and uses its package manager and the session's clipboard", () => {
    const ubuntu = describeComputer(
      facts({
        osRelease: 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\nID_LIKE=debian\n',
        env: { WAYLAND_DISPLAY: 'wayland-0' }
      }),
      shell('/bin/bash')
    )
    expect(ubuntu.os).toBe('Linux (Ubuntu 24.04.1 LTS)')
    const howTo = ubuntu.shell?.howTo.join('\n') ?? ''
    expect(howTo).toContain('wl-copy')
    expect(howTo).toContain('pkexec apt-get install')
    expect(howTo).toContain('gio trash')

    const fedoraX11 = describeComputer(
      facts({ osRelease: 'PRETTY_NAME="Fedora Linux 41"\nID=fedora\n' }),
      shell('/bin/bash')
    )
    const fedora = fedoraX11.shell?.howTo.join('\n') ?? ''
    expect(fedora).toContain('xclip -selection clipboard')
    expect(fedora).toContain('pkexec dnf install')
  })
})

describe('the clipboard on Linux', () => {
  it('names a program that is installed, or says none is', () => {
    const only = (name: string) => (program: string) => program === name
    const wayland = { WAYLAND_DISPLAY: 'wayland-0' }
    const line = (installed: (name: string) => boolean): string =>
      describeComputer(facts({ env: wayland, installed }), shell('/bin/bash')).shell?.howTo.find(
        (entry) => entry.startsWith('Copy text')
      ) ?? ''

    expect(line(only('wl-copy'))).toContain('| wl-copy')
    expect(line(only('xsel'))).toContain('| xsel --clipboard --input')
    expect(line(() => false)).toContain('no clipboard program is installed')
  })
})

describe('everyday hints', () => {
  const linux = (installed: (name: string) => boolean) =>
    describeComputer(facts({ installed }), shell('/bin/bash')).shell?.howTo.join('\n') ?? ''

  it('keep ~ outside quotes, and search by part of a name', () => {
    expect(linux(() => true)).toContain("find ~ -iname '*budget*'")
    expect(linux(() => true)).not.toMatch(/'~/)
  })

  it('name a photo resizer only when one is installed', () => {
    expect(linux((name) => name === 'ffmpeg')).toContain('ffmpeg -i in.jpg -vf scale=iw/2:-1')
    expect(linux(() => false)).not.toContain('smaller copy of a photo')
    const mac = describeComputer(
      facts({ platform: 'darwin', release: '24.1.0', installed: () => false }),
      shell('/bin/zsh')
    )
    expect(mac.shell?.howTo.join('\n')).toContain('sips --resampleWidth')
  })
})

describe('installing', () => {
  // An 8B asked "is Java installed?" read a bare "Install a program" line as
  // the answer and tried to install it. Checking comes first, and installing
  // is marked as something done only on request, on every system.
  it('is offered only on request, after a way to check', () => {
    for (const computer of [
      describeComputer(facts({ platform: 'win32', release: '10.0.22631' }), shell('powershell')),
      describeComputer(facts({ platform: 'darwin', release: '24.1.0' }), shell('/bin/zsh')),
      describeComputer(facts({ osRelease: 'ID=ubuntu\n' }), shell('/bin/bash'))
    ]) {
      const howTo = computer.shell?.howTo ?? []
      const check = howTo.findIndex((line) =>
        line.startsWith('Check whether a program is installed')
      )
      const install = howTo.findIndex((line) => line.startsWith('Install a program'))
      expect(check).toBeGreaterThanOrEqual(0)
      expect(install).toBeGreaterThan(check)
      expect(howTo[install]).toContain('only when the person asks you to install one')
    }
  })
})

describe('the Trash', () => {
  // An 8B asked to send a file to the phone wrote `gio trash <the file> &&
  // xdg-open …`, reading a bare "Move to the Trash" line as a step of sending.
  it('is offered only for removing something, on every system', () => {
    for (const computer of [
      describeComputer(facts({ platform: 'win32', release: '10.0.22631' }), shell('powershell')),
      describeComputer(facts({ platform: 'darwin', release: '24.1.0' }), shell('/bin/zsh')),
      describeComputer(facts({}), shell('/bin/bash'))
    ]) {
      const line = (computer.shell?.howTo ?? []).find((hint) => /Trash|Recycle Bin/.test(hint))
      expect(line).toMatch(/^Move to the (Trash|Recycle Bin), only when the person asks to remove/)
    }
  })
})

describe('the This computer prompt section', () => {
  const base = { hasWorkspaceTools: false, hasProject: false, surface: 'chat' as const }

  it('names the shell and says a plain chat can use it', () => {
    const computer = describeComputer(facts({}), shell('/bin/bash'))
    const prompt = composeSystemPrompt({ ...base, computer })
    expect(prompt).toContain('# This computer')
    expect(prompt).toContain('run_command runs bash on this Linux computer, starting in /home/sam')
    expect(prompt).toContain('Downloads: /home/sam/Downloads')
    expect(prompt).toContain('named gort, signed in as sam')
    expect(prompt).toContain(NO_PROJECT_SHELL_NOTE)
    expect(prompt).not.toContain(NO_WORKSPACE_NOTE)
  })

  it('puts the purpose-built tools ahead of the shell, and plain answers in the reply', () => {
    const prompt = composeSystemPrompt({
      ...base,
      computer: describeComputer(facts({}), shell('/bin/bash'))
    })
    expect(prompt).toContain('when a listed tool does the job')
    expect(prompt).toContain('never printed with echo')
    expect(prompt).toContain("Never guess a file's path")
  })

  it('names only the system when there is no shell this turn', () => {
    const prompt = composeSystemPrompt({ ...base, computer: describeComputer(facts({}), null) })
    expect(prompt).toContain('# This computer')
    expect(prompt).not.toContain('run_command runs')
    expect(prompt).toContain(NO_WORKSPACE_NOTE)
  })
})
