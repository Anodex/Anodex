import { createServer, type Server } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkComputerTool, diskPath, findOnPath } from '../computerCheckTools'
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

  it('measures home for a home shorthand, as a shell would', () => {
    // Gemma 4 E4B asked for "$HOME" and got a folder of that name inside the
    // app's own directory.
    expect(diskPath('$HOME', project, home)).toBe(home)
    expect(diskPath('~', undefined, home)).toBe(home)
    expect(diskPath('"%USERPROFILE%"', undefined, home)).toBe(home)
  })

  it('reads a relative path from the project, or from home without one', () => {
    expect(diskPath('data', project, home)).toBe(path.join(project, 'data'))
    expect(diskPath('Downloads', undefined, home)).toBe(path.join(home, 'Downloads'))
  })

  it('measures the project, or home, when no path is given', () => {
    expect(diskPath(undefined, project, home)).toBe(project)
    expect(diskPath('  ', undefined, home)).toBe(home)
  })

  it('keeps an absolute path as it is', () => {
    expect(diskPath(tmpdir(), project, home)).toBe(tmpdir())
  })

  it('reports the real home folder for "$HOME" through the tool', async () => {
    expect(await check({ check: 'disk', path: '$HOME' })).toContain(homedir())
  })
})
