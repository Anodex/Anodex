import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const { BackgroundProcessService } = await import('../BackgroundProcessService')

/** A `node -e` command line, quoted to work under cmd.exe and POSIX shells alike. */
function node(script: string): string {
  return `"${process.execPath}" -e "${script}"`
}

const service = new BackgroundProcessService()
const options = { cwd: tmpdir(), projectId: 'p1', conversationId: 'c1' }

afterEach(async () => {
  await service.stopAll()
})

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('BackgroundProcessService', () => {
  it('keeps a process running, collects its output, and finds the address it serves', async () => {
    const info = service.start({
      ...options,
      command: node("console.log('Local: http://localhost:4321/'); setInterval(() => {}, 1000)")
    })
    await until(() => service.get(info.id)?.url !== null)

    expect(service.get(info.id)).toMatchObject({
      status: 'running',
      url: 'http://localhost:4321/'
    })
    expect(service.output(info.id)?.text).toContain('Local: http://localhost:4321/')
  })

  it('stops what the process started, not only the process itself', async () => {
    // A shell, then node, then the grandchild that would hold a port.
    const info = service.start({
      ...options,
      command: node(
        "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); console.log('child=' + c.pid); setInterval(() => {}, 1000)"
      )
    })
    await until(() => /child=\d+/.test(service.output(info.id)?.text ?? ''))
    const grandchild = Number(/child=(\d+)/.exec(service.output(info.id)?.text ?? '')?.[1])
    expect(alive(grandchild)).toBe(true)

    const stopped = await service.stop(info.id)
    expect(stopped?.status).toBe('stopped')
    await until(() => !alive(grandchild))
  })

  it('records how a process ended on its own', async () => {
    const info = service.start({ ...options, command: node('process.exit(3)') })
    const ended = await service.waitForExit(info.id, 10_000)
    expect(ended).toMatchObject({ status: 'exited', exitCode: 3 })
  })

  it('keeps only the recent end of a flood of output', async () => {
    const info = service.start({
      ...options,
      command: node("process.stdout.write('x'.repeat(200000) + 'END')")
    })
    await service.waitForExit(info.id, 10_000)
    const output = service.output(info.id)
    expect(output?.text.endsWith('END')).toBe(true)
    expect(output?.text.length).toBeLessThanOrEqual(64 * 1024)
    expect(output?.truncated).toBe(true)
  })

  it('lists a project’s processes only', async () => {
    const own = new BackgroundProcessService()
    try {
      const mine = own.start({ ...options, command: node('setInterval(() => {}, 1000)') })
      own.start({ ...options, projectId: 'p2', command: node('setInterval(() => {}, 1000)') })
      expect(own.list('p1').map((info) => info.id)).toEqual([mine.id])
    } finally {
      await own.stopAll()
    }
  })
})
