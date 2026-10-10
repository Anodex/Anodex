import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolConfirmRequest } from '@shared/tools.types'
import { checkLongRunningServer } from '../commandGuidance'
import {
  listProcessesTool,
  readProcessOutputTool,
  startProcessTool,
  stopProcessTool
} from '../processTools'
import { backgroundProcessService } from '../../processes/BackgroundProcessService'
import { createMockContext, createMockDefine } from './test-helpers'

type Handler<A> = { handler: (args: A) => Promise<string> }

/** A `node -e` command line, quoted to work under cmd.exe and POSIX shells alike. */
function node(script: string): string {
  return `"${process.execPath}" -e "${script}"`
}

const SERVER = node("console.log('ready on http://localhost:4567/'); setInterval(() => {}, 1000)")

describe('background process tools', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-process-'))
  })

  afterEach(async () => {
    await backgroundProcessService.stopAll()
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
      () => {}
    )
  })

  function tools(projectId: string, confirmations: ToolConfirmRequest[] = []) {
    const ctx = {
      ...createMockContext(workspace),
      projectId,
      confirm: (request: ToolConfirmRequest) => {
        confirmations.push(request)
        return Promise.resolve({ approved: true })
      }
    }
    const define = createMockDefine()
    return {
      start: startProcessTool(define, ctx) as unknown as Handler<{
        command: string
        name?: string
      }>,
      read: readProcessOutputTool(define, ctx) as unknown as Handler<{ id: string }>,
      list: listProcessesTool(define, ctx) as unknown as Handler<Record<string, never>>,
      stop: stopProcessTool(define, ctx) as unknown as Handler<{ id: string }>
    }
  }

  function idFrom(result: string): string {
    const id = /\(id ([0-9a-f]{8})\)/.exec(result)?.[1]
    if (!id) throw new Error(`no id in: ${result}`)
    return id
  }

  it('starts a server that keeps running, asks first, and says where it serves', async () => {
    const confirmations: ToolConfirmRequest[] = []
    const { start } = tools('p1', confirmations)

    const result = await start.handler({ command: SERVER, name: 'web server' })

    expect(confirmations).toHaveLength(1)
    expect(result).toContain('"web server"')
    expect(result).toContain('is running at http://localhost:4567/')
    expect(result).toContain('keeps running after this reply')
    expect(backgroundProcessService.get(idFrom(result))?.status).toBe('running')
  })

  it('reports a process that dies at once, with what it printed', async () => {
    const { start } = tools('p1')
    const result = await start.handler({
      command: node("console.error('Error: port 3000 in use'); process.exit(1)")
    })
    expect(result).toContain('exited with code 1')
    expect(result).toContain('port 3000 in use')
  })

  it('reads, lists and stops a process for the project that started it', async () => {
    const { start, read, list, stop } = tools('p1')
    const id = idFrom(await start.handler({ command: SERVER }))

    expect(await read.handler({ id })).toContain('ready on http://localhost:4567/')
    expect(await list.handler({})).toContain(`(id ${id})`)
    expect(await stop.handler({ id })).toContain('was stopped')
    expect(backgroundProcessService.get(id)?.status).toBe('stopped')
  })

  it('cannot see or stop another project’s process', async () => {
    const id = idFrom(await tools('p1').start.handler({ command: SERVER }))
    const other = tools('p2')

    expect(await other.read.handler({ id })).toContain('No background process')
    expect(await other.stop.handler({ id })).toContain('No background process')
    expect(backgroundProcessService.get(id)?.status).toBe('running')
  })

  it('points run_command at start_process for a server, when it is available', () => {
    expect(checkLongRunningServer('npm run dev', true)).toContain('Use start_process')
    expect(checkLongRunningServer('npm run dev', false)).not.toContain('start_process')
  })
})
