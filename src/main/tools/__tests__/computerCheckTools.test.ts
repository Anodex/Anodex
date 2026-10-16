import { createServer, type Server } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import {
  checkComputerTool,
  diskPath,
  findInstalled,
  findOnPath,
  programNames
} from '../computerCheckTools'
import { operatingSystemName } from '../../chat/thisComputer'
import { createMockContext, createMockDefine } from './test-helpers'

type Args = {
  check: 'program' | 'port' | 'disk' | 'system'
  name?: string
  port?: number
  path?: string
}

function check(args: Args): Promise<string> {
  const ctx = {
    ...createMockContext(tmpdir()),
    confirm: () => Promise.reject(new Error('a read-only check must never ask'))
  }
  const fn = checkComputerTool(createMockDefine(), ctx) as unknown as {
    handler: (a: Args) => Promise<string>
  }
  return fn.handler(args)
}

let server: Server | null = null
afterEach(async () => {
  if (server) await new Promise((resolve) => server?.close(resolve))
  server = null
})

describe('check_computer', () => {
  it('finds an installed program and reports its version, without asking', async () => {
    const result = await check({ check: 'program', name: 'node' })
    expect(result).toMatch(/node is installed at .+\. Version: v\d+/)
  })

  it('says plainly when a program is not installed', async () => {
    const result = await check({ check: 'program', name: 'anodex-no-such-program' })
    expect(result).toContain('is not installed')
  })

  it('runs nothing but a bare program name', async () => {
    for (const name of ['node; rm -rf ~', '../bin/node', 'node --eval']) {
      expect(await check({ check: 'program', name })).toContain('Give just a program name')
    }
  })

  it('tells a port in use from a free one', async () => {
    server = createServer()
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    expect(await check({ check: 'port', port })).toContain('is in use')

    await new Promise((resolve) => server?.close(resolve))
    server = null
    expect(await check({ check: 'port', port })).toContain('is free')
  })

  it('reports disk space and the machine', async () => {
    expect(await check({ check: 'disk', path: tmpdir() })).toMatch(/free of .+ on the disk holding/)
    expect(await check({ check: 'system' })).toMatch(/OS: .+\nCPU: .+\nMemory: /)
  })
})

describe('findOnPath', () => {
  it('returns nothing for a program that is nowhere on PATH', () => {
    expect(findOnPath('definitely-not-here', { PATH: tmpdir() }, 'linux')).toBeNull()
  })
})

describe('diskPath', () => {
  const home = path.resolve('/home/sam')
  const project = path.resolve('/work/site')
  // OneDrive's Documents, which is not under home: the lookup has to win.
  const known = { home, documents: path.resolve('/cloud/Documents') }

  it('measures home for a home shorthand, as a shell would', () => {
    // Gemma 4 E4B asked for "$HOME" and got a folder of that name inside the
    // app's own directory.
    expect(diskPath('$HOME', project, known)).toBe(home)
    expect(diskPath('~', undefined, known)).toBe(home)
    expect(diskPath('"%USERPROFILE%"', undefined, known)).toBe(home)
  })

  it('reads an everyday folder where this computer keeps it', () => {
    // A plain chat works in Documents, so "Documents" read from there was
    // Documents/Documents.
    expect(diskPath('Documents', known.documents, known)).toBe(known.documents)
    expect(diskPath('documents/taxes', undefined, known)).toBe(path.join(known.documents, 'taxes'))
  })

  it('reads any other relative path from the project, or from home without one', () => {
    expect(diskPath('data', project, known)).toBe(path.join(project, 'data'))
    // Downloads is not in `known` here, so it is an ordinary name.
    expect(diskPath('Downloads', undefined, known)).toBe(path.join(home, 'Downloads'))
  })

  it('measures the project, or home, when no path is given', () => {
    expect(diskPath(undefined, project, known)).toBe(project)
    expect(diskPath('  ', undefined, known)).toBe(home)
  })

  it('keeps an absolute path as it is', () => {
    expect(diskPath(tmpdir(), project, known)).toBe(tmpdir())
  })
})

describe('check_computer disk', () => {
  it('reports the real home folder for "$HOME"', async () => {
    expect(await check({ check: 'disk', path: '$HOME' })).toContain(homedir())
  })

  it('measures the disk a folder not made yet would be on', async () => {
    const future = path.join(tmpdir(), 'anodex-not-made-yet', 'game')
    expect(await check({ check: 'disk', path: future })).toMatch(
      /free of .+ on the disk holding .+anodex-not-made-yet/
    )
  })
})

describe('check_computer system report', () => {
  it('names the operating system the way the prompt does', async () => {
    // It printed os.release(): "Windows 10.0.26200" is Windows 11, read by
    // both models as Windows 10, against a prompt that said Windows 11.
    const report = await check({ check: 'system' })
    expect(report).toContain(`OS: ${operatingSystemName()} (build `)
  })
})

describe('programNames', () => {
  it('tries the other names a program goes by', () => {
    // "nodejs" was reported not installed on a machine where `node` was.
    expect(programNames('nodejs')).toEqual(['nodejs', 'node', 'node.js'])
    expect(programNames('Node.js')).toEqual(['Node.js', 'node.js', 'node', 'nodejs'])
    expect(programNames('python3')).toContain('py')
  })

  it('leaves a program with one name as it is', () => {
    expect(programNames('git')).toEqual(['git'])
  })

  it('finds node when asked for nodejs', async () => {
    expect(await check({ check: 'program', name: 'nodejs' })).toMatch(
      /node is installed at .+\. Version: v\d+/
    )
  })
})

describe('findInstalled', () => {
  const made: string[] = []
  const scratch = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'anodex-installed-'))
    made.push(dir)
    return dir
  }
  const file = (where: string): string => {
    mkdirSync(path.dirname(where), { recursive: true })
    writeFileSync(where, '')
    chmodSync(where, 0o755)
    return where
  }
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  // Python 3.12 from python.org, "Add to PATH" left unticked, as on the laptop
  // where "Do I have Python installed?" was answered no five times in five.
  it('finds a Windows program in its install folder, off the PATH, and says so', () => {
    const local = scratch()
    const exe = file(path.join(local, 'Programs', 'Python', 'Python312', 'anodexpy.exe'))
    expect(findInstalled('anodexpy', { PATH: '', LOCALAPPDATA: local }, 'win32')).toEqual({
      path: exe,
      onPath: false
    })
  })

  it('finds one in a bin or cmd folder too', () => {
    const programFiles = scratch()
    const exe = file(path.join(programFiles, 'Git', 'cmd', 'anodexgit.exe'))
    expect(
      findInstalled('anodexgit', { PATH: '', ProgramFiles: programFiles }, 'win32')?.path
    ).toBe(exe)
  })

  // An app opened from the Dock starts with /usr/bin:/bin:/usr/sbin:/sbin.
  it('looks where a Mac app’s PATH does not, such as ~/.local/bin', () => {
    const home = scratch()
    const tool = file(path.join(home, '.local', 'bin', 'anodex-tool'))
    expect(findInstalled('anodex-tool', { PATH: '/usr/bin:/bin', HOME: home }, 'darwin')).toEqual({
      path: tool,
      onPath: false
    })
  })

  it('prefers the PATH, and reports nothing for a program that is not there', () => {
    const bin = scratch()
    const exe = file(
      path.join(bin, process.platform === 'win32' ? 'anodexonpath.exe' : 'anodexonpath')
    )
    expect(findInstalled('anodexonpath', { PATH: bin, PATHEXT: '.EXE' })).toEqual({
      path: exe,
      onPath: true
    })
    expect(findInstalled('anodex-not-a-program', { PATH: '', HOME: scratch() })).toBeNull()
  })
})
